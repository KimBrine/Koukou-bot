# name: 禁漫下载
# desc: 后台下载 JM 本子/章节到本地，可查进度（文件存本地，不在聊天里发图）
# usage: /py jm 初始化 → /py jm 123456 → /py jm 状态
# admin: true
"""
jm.py —— 机器人用的后台下载插件

为什么是"两段式"：/py 有 20 秒超时、只回文本，而下载一本要几分钟。
所以这里只做三件事：提交任务、把 worker 甩到独立进程、之后查状态。

首次使用：
    1. pip install jmcomic
    2. /py jm 初始化        → 生成 ~/jmcomic/option.yml（Windows 是 C:\\Users\\你\\jmcomic\\）
    3. 按需改里面的代理、下载路径
    4. /py jm 123456        → 开始下载

子命令：
    初始化 [目录]   生成配置文件，默认 ~/jmcomic/option.yml
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
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
CONFIG_NAME = 'option.yml'
LOG_TAIL = 8
IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif')

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
            f'需要代理就改里面的 proxies，然后 /py jm 123456 开始下载')


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


# ---------- 提交 ----------

def submit(raw_id):
    raw_id = raw_id.strip()
    if not raw_id:
        raise SystemExit('用法：/py jm 123456 或 /py jm p345678')

    kind = 'photo' if raw_id[:1].lower() == 'p' else 'album'
    jm_id = raw_id[1:] if kind == 'photo' else raw_id
    if not jm_id.isdigit():
        raise SystemExit(f'id 必须是数字：{raw_id}')

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

    with open(_log_file(job_id), 'ab') as log:
        subprocess.Popen(cmd, cwd=str(HERE), stdin=subprocess.DEVNULL,
                         stdout=log, stderr=subprocess.STDOUT, close_fds=True, **kwargs)

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
    if low in ('检查', 'doctor', '自检'):
        print(cmd_doctor())
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
