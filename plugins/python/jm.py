# name: 禁漫下载
# desc: 后台下载 JM 本子/章节到本地；也能直接查详情（标题/作者/页数/标签/章节）发到聊天里
# usage: /py jm 初始化 → /py jm 查 350234 → /py jm 350234 → /py jm 状态
# admin: true
"""
jm.py —— 机器人用的后台下载插件 + 详情查询

为什么下载是"两段式"：/py 有 20 秒超时、只回文本，而下载一本要几分钟。
所以下载只做三件事：提交任务、把 worker 甩到独立进程、之后查状态。
查询（查）是同步的，一般 1~3 秒返回，结果直接发在聊天里。

首次使用：
    1. pip install jmcomic
    2. /py jm 初始化        → 生成 ~/jmcomic/option.yml（Windows 是 C:\\Users\\你\\jmcomic\\）
    3. 按需改里面的代理、下载路径
    4. /py jm 查 350234     → 先看详情；/py jm 350234 开始下载

子命令：
    初始化 [目录]   生成配置文件（已有配置时只提示现有路径，不重复生成）
    目录 [路径]     查看/修改下载目录（写回 option.yml 的 base_dir）
    查/查询/jmv 350234   查本子详情（不发图，纯文本）
    发图 350234 [张数]    直接把第一话前几张图发到聊天（默认3，最多6）
    记录 350234 [张数]    详情+整话图片打包成一条聊天记录卡片（不填张数=整话全部）
    打包 350234 [分钟]    把已下载的本子压成 zip 以文件发送，默认 5 分钟后撤回
    123456          下载本子(album)
    p345678         下载单个章节(photo)
    状态/status     当前任务进度
    列表/list       最近任务
    日志/log [id]   看任务日志尾部
    检查/doctor     自检：jmcomic、配置、目录是否正常
    帮助/help       显示本说明

配置查找顺序（先找到先用）：
    $JM_OPTION → <本脚本目录>/option.yml → ~/jmcomic/option.yml
状态目录：$JM_STATE，默认 <option.yml 所在目录>/state
"""

import json
import os
import re
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_NAME = 'option.yml'
LOG_TAIL = 8
IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif')


def _force_utf8_stdio():
    """机器人以管道方式调用 Python 时，Windows 默认用 GBK 输出，emoji 会直接抛
    UnicodeEncodeError。这里强制 UTF-8，且用 replace 兜底，宁可显示问号也不要整条失败。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding='utf-8', errors='replace')
        except Exception:
            pass


_force_utf8_stdio()

TEMPLATE = '''# jmcomic 配置（由 jm.py 初始化生成，可自由修改）
# 下载路径：图片会落在 base_dir 下，按 rule 分子目录
log: true

client:
  # api = APP端接口，IP 限制少（推荐）；html = 网页端，速度快但限制地区
  impl: api
  retry_times: 5
  postman:
    meta_data:
      # system = 跟随系统代理；null = 直连；也可以写 127.0.0.1:7890
      proxies: system
      # 少数需要登录的本子，填浏览器里的 AVS 值（不要把真实值提交到仓库）
      cookies: null

download:
  cache: true
  image:
    decode: true
    suffix: .jpg
  threading:
    image: 30
    photo: 8

dir_rule:
  base_dir: __DOWNLOAD__
  # 根目录 / JM{本子id}-{标题} / {章节序号}-{章节标题} / 图片
  rule: Bd / JM{Aid}-{Atitle} / {Pindex}-{Ptitle}
'''


# ---------- 路径解析 ----------

def jm_home() -> Path:
    return Path(os.environ.get('JM_HOME') or (Path.home() / 'jmcomic'))


def find_option() -> Path:
    raw = os.environ.get('JM_OPTION')
    candidates = [raw] if raw else []
    candidates += [str(HERE / CONFIG_NAME), str(jm_home() / CONFIG_NAME)]
    for c in candidates:
        if c and Path(c).is_file():
            return Path(c).resolve()
    raise SystemExit('没找到 option.yml。先执行：/py jm 初始化')


def state_dir() -> Path:
    raw = os.environ.get('JM_STATE')
    return Path(raw).resolve() if raw else find_option().parent / 'state'


def download_dir() -> Path:
    """从 option.yml 读 base_dir，读不到就用 option 同级的 download。"""
    try:
        from jmcomic import create_option
        return Path(create_option(str(find_option())).dir_rule.base_dir)
    except SystemExit:
        raise
    except Exception:
        return find_option().parent / 'download'


# ---------- 任务状态 ----------

def _job_file(job_id) -> Path:
    return state_dir() / f'{job_id}.json'


def _log_file(job_id) -> Path:
    return state_dir() / f'{job_id}.log'


def load_job(job_id):
    path = _job_file(job_id)
    if not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        return None


def save_job(rec):
    state_dir().mkdir(parents=True, exist_ok=True)
    tmp = _job_file(rec['job']).with_suffix('.tmp')
    tmp.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding='utf-8')
    os.replace(tmp, _job_file(rec['job']))


def all_jobs():
    d = state_dir()
    if not d.is_dir():
        return []
    out = []
    for f in d.glob('*.json'):
        rec = load_job(f.stem)
        if rec and rec.get('job'):
            out.append(rec)
    out.sort(key=lambda r: r.get('start', 0), reverse=True)
    return out


# ---------- 进度 ----------

def count_new_images(root, since):
    root = Path(root)
    if not root.is_dir():
        return 0
    n = 0
    for p in root.rglob('*'):
        if p.suffix.lower() not in IMG_EXT:
            continue
        try:
            if p.stat().st_mtime >= since:
                n += 1
        except OSError:
            pass
    return n


def human_time(sec):
    sec = int(max(0, sec))
    if sec < 60:
        return f'{sec}秒'
    if sec < 3600:
        return f'{sec // 60}分{sec % 60}秒'
    return f'{sec // 3600}时{sec % 3600 // 60}分'


def tail_text(path, n=LOG_TAIL):
    path = Path(path)
    if not path.is_file():
        return []
    try:
        lines = [ln.rstrip() for ln in path.read_text(encoding='utf-8', errors='replace').splitlines()]
        return [ln for ln in lines if ln.strip()][-n:]
    except Exception:
        return []


# ---------- 初始化 / 自检 ----------

def cmd_init(arg=''):
    # 已经有生效配置时不要再生成一份，否则新文件会被前一个候选路径遮住，改了也不生效
    try:
        active = find_option()
        return (f'配置已存在，正在用它：\n{active}\n'
                f'当前下载目录：{download_dir()}\n'
                f'改目录：/py jm 目录 D:\\jmcomic\\download')
    except SystemExit:
        pass

    target = Path(arg).expanduser() if arg else jm_home()
    if not target.is_absolute():
        target = (HERE / target).resolve()
    target.mkdir(parents=True, exist_ok=True)

    opt = target / CONFIG_NAME
    if opt.is_file():
        return f'配置已存在，没有覆盖：\n{opt}'

    download = (target / 'download').as_posix()
    opt.write_text(TEMPLATE.replace('__DOWNLOAD__', download), encoding='utf-8')
    return (f'已生成配置：{opt}\n'
            f'下载目录：{download}\n'
            f'要换盘：/py jm 目录 D:\\jmcomic\\download')


def cmd_setdir(raw=''):
    """改生效配置里的下载目录（base_dir），不用手改文件。"""
    raw = (raw or '').strip().strip('"').strip("'")
    if not raw:
        return (f'当前下载目录：{download_dir()}\n'
                f'配置：{find_option()}\n'
                f'改目录：/py jm 目录 D:\\jmcomic\\download')

    target = Path(raw).expanduser()
    if not target.is_absolute():
        return '请写绝对路径，比如 /py jm 目录 D:\\jmcomic\\download'

    opt = find_option()
    text = opt.read_text(encoding='utf-8')
    value = target.as_posix()

    if re.search(r'(?m)^\s*base_dir\s*:', text):
        text = re.sub(r'(?m)^(\s*base_dir\s*:\s*).*$', lambda m: m.group(1) + value, text, count=1)
    else:
        text = text.rstrip('\n') + f'\n\ndir_rule:\n  base_dir: {value}\n'
    opt.write_text(text, encoding='utf-8')

    try:
        actual = download_dir()
        return f'已改：{opt}\n下载目录 → {actual}\n（目录会在第一次下载时自动创建）'
    except Exception as e:
        return f'已写入 {opt}，但读取校验失败：{type(e).__name__}: {e}'


def cmd_doctor():
    lines = []
    lines.append(f'Python {sys.version.split()[0]}（{sys.executable}）')

    try:
        import jmcomic
        lines.append(f'jmcomic {getattr(jmcomic, "__version__", "?")} ✅')
    except Exception as e:
        lines.append(f'jmcomic 未安装 ❌ {type(e).__name__}（执行 pip install jmcomic）')

    try:
        opt = find_option()
        lines.append(f'配置 {opt} ✅')
    except SystemExit as e:
        lines.append(f'配置缺失 ❌ {e}（执行 /py jm 初始化）')
        return '\n'.join(lines)

    try:
        base = download_dir()
        base.mkdir(parents=True, exist_ok=True)
        probe = base / '.jm_write_test'
        probe.write_text('ok', encoding='utf-8')
        probe.unlink()
        lines.append(f'下载目录 {base} 可写 ✅')
    except Exception as e:
        lines.append(f'下载目录不可写 ❌ {type(e).__name__}: {e}')

    try:
        sd = state_dir()
        sd.mkdir(parents=True, exist_ok=True)
        lines.append(f'状态目录 {sd} ✅')
    except Exception as e:
        lines.append(f'状态目录不可用 ❌ {type(e).__name__}: {e}')

    return '\n'.join(lines)


# ---------- 详情查询 ----------

CACHE_TTL = 1800


def _cache_dir() -> Path:
    return state_dir() / 'cache'


def cache_get(key):
    try:
        p = _cache_dir() / f'{key}.json'
        if not p.is_file():
            return None
        data = json.loads(p.read_text(encoding='utf-8'))
        if time.time() - data.get('ts', 0) > CACHE_TTL:
            return None
        return data.get('text')
    except Exception:
        return None


def cache_put(key, text):
    try:
        d = _cache_dir()
        d.mkdir(parents=True, exist_ok=True)
        (d / f'{key}.json').write_text(
            json.dumps({'ts': time.time(), 'text': text}, ensure_ascii=False), encoding='utf-8')
    except Exception:
        pass


def _fmt_num(n):
    try:
        n = int(n)
    except (TypeError, ValueError):
        return str(n if n is not None else 0)
    if n >= 1_000_000:
        return f'{n / 1_000_000:.1f}M'
    if n >= 1_000:
        return f'{n / 1_000:.1f}K'
    return str(n)


def _fmt_date(v):
    s = str(v).strip() if v is not None else ''
    return '-' if s in ('', '0', 'None', 'null') else s


def _fmt_list(items, limit=8):
    items = [str(x) for x in (items or [])]
    if not items:
        return ''
    shown = ', '.join(items[:limit])
    return shown + (f' 等{len(items)}个' if len(items) > limit else '')


def _with_timeout(fn, seconds=12):
    """在子线程里跑，超时就放弃 —— 保证不会撞上 /py 的 20 秒限制。"""
    box = {}

    def run():
        try:
            box['value'] = fn()
        except BaseException as e:  # noqa: BLE001
            box['error'] = e

    t = threading.Thread(target=run, daemon=True)
    t.start()
    t.join(seconds)
    if t.is_alive():
        raise TimeoutError(f'超过 {seconds} 秒')
    if 'error' in box:
        raise box['error']
    return box.get('value')


def _quiet_jmcomic():
    """关掉 jmcomic 自己的日志，否则会混进聊天回复里（还吃 1500 字上限）。"""
    try:
        import logging
        logging.getLogger('jmcomic').setLevel(logging.CRITICAL)
        import jmcomic
        jmcomic.disable_jm_log()
    except Exception:
        pass


def format_album(album, limit=1100):
    from jmcomic import JmcomicText

    def g(name, default=None):
        return getattr(album, name, default)

    lines = [
        f'📖 {g("name") or g("title") or "(无标题)"}',
        f'🆔 JM{album.album_id}   👤 {_fmt_list(g("authors"), 3) or "未知"}',
        f'📅 发布 {_fmt_date(g("pub_date"))}  更新 {_fmt_date(g("update_date"))}  📄 {g("page_count", 0)} 页',
        f'👀 {_fmt_num(g("views"))}   ❤️ {_fmt_num(g("likes"))}   💬 {_fmt_num(g("comment_count"))}',
    ]

    tags = _fmt_list(g('tags'), 10)
    if tags:
        lines.append('🏷️ ' + tags)
    works = _fmt_list(g('works'), 4)
    if works:
        lines.append('📚 ' + works)
    actors = _fmt_list(g('actors'), 4)
    if actors:
        lines.append('🎭 ' + actors)

    desc = (g('description') or '').strip().replace('\n', ' ')
    if desc:
        lines.append('📝 ' + desc[:120])

    episodes = g('episode_list') or []
    if episodes:
        lines.append(f'📑 章节 {len(episodes)}：')
        for ep in episodes[:6]:
            try:
                pid, pindex, pname = ep
            except (TypeError, ValueError):
                pid, pindex, pname = '?', '?', str(ep)
            lines.append(f'  {pindex}. {str(pname).strip()[:16]} (p{pid})')
        if len(episodes) > 6:
            lines.append(f'  …还有 {len(episodes) - 6} 章')

    lines.append(f'🔗 {JmcomicText.format_album_url(album.album_id)}')
    lines.append(f'▶ 下载：/py jm {album.album_id}')

    text = '\n'.join(lines)
    if len(text) > limit:
        text = text[:limit - 12].rstrip() + '\n…（已截断）'
    return text


def cmd_info(raw):
    raw = (raw or '').strip()
    if raw[:1].lower() == 'p':
        return ('这是章节号。查详情用本子号：/py jm 查 350234\n'
                '只下这一章：/py jm ' + raw)

    digits = re.findall(r'\d+', raw)
    if not digits:
        return '用法：/py jm 查 350234\n（数字就行，前后带别的字也行）'
    album_id = ''.join(digits)

    cached = cache_get(f'album_{album_id}')
    if cached:
        return cached

    def fetch():
        from jmcomic import create_option
        option = create_option(str(find_option()))
        _quiet_jmcomic()
        return option.new_jm_client().get_album_detail(int(album_id))

    try:
        album = _with_timeout(fetch, 12)
    except TimeoutError:
        return '查询超时了（12 秒）。多半是代理或网速，先跑 /py jm 检查 看配置。'
    except SystemExit as e:
        return str(e)
    except Exception as e:
        return f'查询失败：{type(e).__name__}: {str(e)[:120]}'

    text = format_album(album)
    cache_put(f'album_{album_id}', text)
    return text


def _download_one(client, img, photo, outdir, retry=2):
    save_path = outdir / img.filename
    for attempt in range(retry + 1):
        try:
            if save_path.is_file() and save_path.stat().st_size > 0:
                return save_path
            client.download_image(img.download_url, str(save_path),
                                  photo.scramble_id, decode_image=True)
            return save_path
        except Exception:
            if attempt >= retry:
                raise
            time.sleep(0.4)
    return save_path


def _fetch_pages(album_id, count=None, timeout=18):
    """取某一话的图片（已解密）。count=None 表示整话全部。
    返回 (album, pindex, pname, files, total)。"""
    from concurrent.futures import ThreadPoolExecutor

    def fetch():
        from jmcomic import create_option
        option = create_option(str(find_option()))
        _quiet_jmcomic()
        client = option.new_jm_client()
        album = client.get_album_detail(int(album_id))
        episodes = getattr(album, 'episode_list', None) or []
        if not episodes:
            raise RuntimeError('这本没有章节信息')
        pid, pindex, pname = episodes[0]

        photo = client.get_photo_detail(pid, fetch_album=True, fetch_scramble_id=True)
        outdir = state_dir() / 'images' / str(photo.photo_id)
        outdir.mkdir(parents=True, exist_ok=True)

        images = list(photo)
        total = len(images)
        if count:
            images = images[:count]

        with ThreadPoolExecutor(max_workers=8) as pool:
            files = list(pool.map(lambda im: _download_one(client, im, photo, outdir), images))
        return album, pindex, pname, files, total

    return _with_timeout(fetch, timeout)


def _page_head(album, pindex, pname, total, n):
    return (f'📖 {getattr(album, "name", "")} 第{pindex}话 {str(pname).strip()[:12]}\n'
            f'共 {total or "?"} 页，先发前 {n} 页：')


def cmd_send_images(raw, count_arg=''):
    """把图片以 CQ 码直接发在聊天里。"""
    digits = re.findall(r'\d+', raw or '')
    if not digits:
        return '用法：/py jm 发图 350234 [张数]\n默认 3 张，最多 20 张。'
    arg = str(count_arg).strip().lower()
    if arg in ('全部', 'all'):
        count = 20
    else:
        try:
            count = int(arg or 3)
        except ValueError:
            count = 3
    count = max(1, min(count, 20))

    try:
        album, pindex, pname, files, total = _fetch_pages(''.join(digits), count, 18)
    except TimeoutError:
        return '下载图片超时（18 秒）。网慢时先 /py jm 350234 后台下载，再 /py jm 发图 350234。'
    except SystemExit as e:
        return str(e)
    except Exception as e:
        return f'发图失败：{type(e).__name__}: {str(e)[:120]}'

    if not files:
        return '没取到图片，可能这一话没有内容。'
    codes = '\n'.join(f'[CQ:image,file={p.as_posix()}]' for p in files)
    return _page_head(album, pindex, pname, total, len(files)) + '\n' + codes


def cmd_card(raw, count_arg=''):
    """把详情和这一话的全部图片打包成一条「聊天记录」卡片。"""
    digits = re.findall(r'\d+', raw or '')
    if not digits:
        return '用法：/py jm 记录 350234 [张数]\n不填张数就是整话全部。'
    album_id = ''.join(digits)

    arg = str(count_arg).strip().lower()
    if arg in ('', '全部', 'all', '0'):
        count = None
    else:
        try:
            count = max(1, min(int(arg), 40))
        except ValueError:
            count = None

    try:
        album, pindex, pname, files, total = _fetch_pages(album_id, count, 18)
    except TimeoutError:
        return '生成聊天记录超时（18 秒）。先 /py jm 350234 后台下载，再试 /py jm 记录 350234。'
    except SystemExit as e:
        return str(e)
    except Exception as e:
        return f'生成记录失败：{type(e).__name__}: {str(e)[:120]}'

    if not files:
        return '没取到图片，可能这一话没有内容。'

    from jmcomic import JmcomicText

    title = getattr(album, 'name', '') or 'JM'
    info = '\n'.join(x for x in [
        f'📖 {title}',
        f'🆔 JM{album.album_id}   👤 {_fmt_list(getattr(album, "authors", None), 3) or "未知"}',
        f'📅 {_fmt_date(getattr(album, "pub_date", None))}   📄 {getattr(album, "page_count", 0)} 页',
        ('🏷️ ' + _fmt_list(getattr(album, 'tags', None), 8)) if getattr(album, 'tags', None) else '',
        f'📑 第{pindex}话 {str(pname).strip()[:16]}（共 {total or "?"} 页）',
    ] if x)

    nodes = [{'text': info}]
    for i, p in enumerate(files, 1):
        nodes.append({'text': f'{i}/{len(files)}', 'images': [p.as_posix()]})
    nodes.append({'text': f'🔗 {JmcomicText.format_album_url(album.album_id)}\n'
                          f'下载：/py jm {album.album_id}'})

    payload = {'name': 'JM', 'summary': f'{title[:20]} ｜ {len(files)} 张图', 'nodes': nodes}
    return '@@CARD@@' + json.dumps(payload, ensure_ascii=False)


def cmd_pack(raw='', minutes_arg=''):
    """把已下载的本子目录压成 zip，交给机器人以文件形式发送（可自动撤回）。"""
    import zipfile

    base = download_dir()
    if not base.is_dir():
        return '下载目录还不存在，先 /py jm 350234 下载。'

    digits = re.findall(r'\d+', raw or '')
    target = None
    if digits:
        album_id = ''.join(digits)
        for child in sorted(base.iterdir()):
            if child.is_dir() and album_id in child.name:
                target = child
                break
        if target is None:
            return f'没找到已下载的 JM{album_id}。先 /py jm {album_id} 下完再打包。'
    else:
        dirs = [c for c in base.iterdir() if c.is_dir()]
        if not dirs:
            return '下载目录里还没有本子。'
        target = max(dirs, key=lambda p: p.stat().st_mtime)

    try:
        minutes = int(str(minutes_arg).strip() or 5)
    except ValueError:
        minutes = 5
    minutes = max(1, min(minutes, 120))

    outdir = state_dir() / 'exports'
    outdir.mkdir(parents=True, exist_ok=True)
    zip_path = outdir / f'{target.name}.zip'

    try:
        with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_STORED) as zf:
            for f in sorted(target.rglob('*')):
                if f.is_file():
                    zf.write(f, f.relative_to(target.parent))
    except Exception as e:
        return f'打包失败：{type(e).__name__}: {e}'

    size_mb = zip_path.stat().st_size / 1024 / 1024
    payload = {
        'path': zip_path.as_posix(),
        'name': zip_path.name,
        'recall_minutes': minutes,
        'text': f'打包完成：{zip_path.name}（{size_mb:.1f} MB）',
    }
    return '@@FILE@@' + json.dumps(payload, ensure_ascii=False)


# ---------- 提交 ----------

def submit(raw_id):
    raw_id = raw_id.strip()
    if not raw_id:
        raise SystemExit('用法：/py jm 123456 或 /py jm p345678')

    kind = 'photo' if raw_id[:1].lower() == 'p' else 'album'
    jm_id = raw_id[1:] if kind == 'photo' else raw_id
    if not jm_id.isdigit():
        raise SystemExit(f'不认识「{raw_id}」。\n'
                         '下载 /py jm 350234｜查详情 /py jm 查 350234｜'
                         '发图 /py jm 发图 350234｜进度 /py jm 状态｜帮助 /py jm 帮助')

    for rec in all_jobs():
        if rec.get('jm_id') == jm_id and rec.get('kind') == kind and rec.get('status') == 'running':
            return f'这个已经在下了，任务 {rec["job"]}\n用 /py jm 状态 看进度'

    job_id = time.strftime('%m%d%H%M%S') + kind[0] + jm_id[-4:]
    state_dir().mkdir(parents=True, exist_ok=True)

    rec = {
        'job': job_id, 'kind': kind, 'jm_id': jm_id,
        'status': 'running', 'start': time.time(), 'end': None,
        'base_dir': str(download_dir()), 'error': None,
    }
    save_job(rec)

    cmd = [sys.executable, str(Path(__file__).resolve()), '--worker', job_id]
    kwargs = {}
    if os.name == 'nt':
        # DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP：窗口不弹出，机器人退出也不影响它
        kwargs['creationflags'] = 0x00000008 | 0x00000200
    else:
        kwargs['start_new_session'] = True

    env = {**os.environ, 'PYTHONIOENCODING': 'utf-8', 'PYTHONUTF8': '1'}
    with open(_log_file(job_id), 'ab') as log:
        subprocess.Popen(cmd, cwd=str(HERE), stdin=subprocess.DEVNULL,
                         stdout=log, stderr=subprocess.STDOUT, close_fds=True,
                         env=env, **kwargs)

    label = '章节' if kind == 'photo' else '本子'
    return (f'已提交：{label} {jm_id}\n任务 {job_id}\n'
            f'保存到 {rec["base_dir"]}\n稍后用 /py jm 状态 看进度')


# ---------- worker ----------

def worker(job_id):
    rec = load_job(job_id)
    if not rec:
        return 1
    try:
        os.environ.setdefault('PYTHONIOENCODING', 'utf-8')

        if os.environ.get('JM_WORKER_FAKE') == '1':
            print('[fake] 模拟下载开始', flush=True)
            time.sleep(3)
            print('[fake] 模拟下载完成', flush=True)
        else:
            from jmcomic import create_option, jm_log
            option = create_option(str(find_option()))
            jm_log('bot_job', f'job={job_id} 开始下载 {rec["kind"]} {rec["jm_id"]}')
            if rec['kind'] == 'photo':
                option.download_photo(int(rec['jm_id']))
            else:
                option.download_album(int(rec['jm_id']))

        rec['status'] = 'done'
        rec['end'] = time.time()
        rec['images'] = count_new_images(rec.get('base_dir'), rec['start'])
        save_job(rec)
        print('[done]', flush=True)
        return 0
    except BaseException as e:
        rec['status'] = 'failed'
        rec['end'] = time.time()
        rec['error'] = f'{type(e).__name__}: {e}'
        save_job(rec)
        print(f'[failed] {rec["error"]}', flush=True)
        return 1


# ---------- 查询 ----------

def cmd_status():
    jobs = all_jobs()
    if not jobs:
        return '还没有下载任务。\n用 /py jm 123456 提交一个。'

    running = [j for j in jobs if j.get('status') == 'running']
    lines = []
    for rec in (running or jobs[:1]):
        elapsed = (rec.get('end') or time.time()) - rec['start']
        if rec['status'] == 'running':
            n = count_new_images(rec.get('base_dir'), rec['start'])
            head = f'⏳ 任务 {rec["job"]} 进行中（{human_time(elapsed)}，已下载 {n} 张）'
        elif rec['status'] == 'done':
            head = f'✅ 任务 {rec["job"]} 完成（{rec.get("images") or 0} 张，用时 {human_time(elapsed)}）'
        else:
            head = f'⚠️ 任务 {rec["job"]} 失败：{rec.get("error")}'

        lines.append(head)
        lines.append(f'   目标：{rec["kind"]} {rec["jm_id"]}')
        lines.append(f'   目录：{rec.get("base_dir")}')

        tail = tail_text(_log_file(rec['job']), 3)
        if tail:
            lines.append('   最近日志：' + tail[-1][:80])

    if len(running) > 1:
        lines.append(f'\n另有 {len(running) - 1} 个在跑')
    return '\n'.join(lines)


def cmd_list():
    jobs = all_jobs()[:8]
    if not jobs:
        return '还没有下载任务。'
    icon = {'running': '⏳', 'done': '✅', 'failed': '⚠️'}
    lines = ['最近任务：']
    for rec in jobs:
        elapsed = (rec.get('end') or time.time()) - rec['start']
        lines.append(f'{icon.get(rec["status"], "?")} {rec["job"]}  '
                     f'{rec["kind"]} {rec["jm_id"]}  {human_time(elapsed)}')
    return '\n'.join(lines)


def cmd_log(arg=''):
    target = (arg or '').strip()
    if not target:
        jobs = all_jobs()
        if not jobs:
            return '没有任务可看。'
        target = jobs[0]['job']
    for rec in all_jobs():
        if target in (rec['job'], rec['jm_id']):
            lines = tail_text(_log_file(rec['job']), LOG_TAIL)
            return '\n'.join(lines)[-1400:] if lines else f'任务 {rec["job"]} 还没写日志。'
    return f'没找到任务：{target}'


def main(argv):
    if not argv:
        print(__doc__)
        return 0

    cmd = argv[0].strip()
    low = cmd.lower()

    if low in ('初始化', 'init'):
        print(cmd_init(argv[1] if len(argv) > 1 else ''))
        return 0
    if low in ('目录', 'dir', 'setdir'):
        print(cmd_setdir(argv[1] if len(argv) > 1 else ''))
        return 0
    if low in ('检查', 'doctor', '自检'):
        print(cmd_doctor())
        return 0
    if low in ('查', '查询', 'jmv', 'info', 'detail'):
        print(cmd_info(argv[1] if len(argv) > 1 else ''))
        return 0
    if low in ('发图', '图', 'pages', 'img'):
        print(cmd_send_images(argv[1] if len(argv) > 1 else '',
                              argv[2] if len(argv) > 2 else ''))
        return 0
    if low in ('记录', '卡片', 'card', '聊天记录'):
        print(cmd_card(argv[1] if len(argv) > 1 else '',
                       argv[2] if len(argv) > 2 else ''))
        return 0
    if low in ('打包', 'zip', '压缩', '文件'):
        print(cmd_pack(argv[1] if len(argv) > 1 else '',
                       argv[2] if len(argv) > 2 else ''))
        return 0
    if low in ('状态', 'status', '进度'):
        print(cmd_status())
        return 0
    if low in ('列表', 'list', 'ls'):
        print(cmd_list())
        return 0
    if low in ('日志', 'log', 'logs'):
        print(cmd_log(argv[1] if len(argv) > 1 else ''))
        return 0
    if low in ('帮助', 'help', '-h', '--help'):
        print(__doc__)
        return 0

    print(submit(cmd))
    return 0


if __name__ == '__main__':
    if len(sys.argv) > 2 and sys.argv[1] == '--worker':
        sys.exit(worker(sys.argv[2]))
    sys.exit(main(sys.argv[1:]))
