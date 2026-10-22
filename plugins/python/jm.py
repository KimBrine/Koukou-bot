# name: 禁漫下载
# desc: 后台下载 JM 本子/章节到本地，可查进度（仅自己看，不往群里发图）
# usage: /py jm 123456 | /py jm p345678 | /py jm 状态 | /py jm 列表 | /py jm 日志 123456
# admin: true
"""
jm.py —— 机器人用的后台下载插件（提交 + 查询两段式，绕开 /py 的 20 秒超时）

第一次使用前把 option.yml 放好（下载路径、代理都在里面）：
    D:\\jmcomic\\option.yml         ← 或设置环境变量 JM_OPTION 指向你的 yml

提交后立刻返回任务号，真正的下载在独立进程里跑：
    文件落在 option.yml 的 dir_rule.base_dir 下
    状态文件在 JM_STATE（默认 D:\\jmcomic\\state）

子命令：
    123456       下载本子
    p345678      下载单个章节
    状态/status  看当前任务进度
    列表/list    最近任务
    日志/日志 id 看某个任务的下载日志尾部
"""

import json
import os
import subprocess
import sys
import time

# ---------- 路径配置 ----------

_HERE = os.path.dirname(os.path.abspath(__file__))

OPTION_CANDIDATES = [
    os.environ.get('JM_OPTION', ''),
    r'D:\jmcomic\option.yml',
    os.path.join(_HERE, 'option.yml'),
]

STATE_DIR = os.environ.get('JM_STATE') or r'D:\jmcomic\state'

MAX_JOBS_KEEP = 50
LOG_TAIL = 8


def option_path():
    for p in OPTION_CANDIDATES:
        if p and os.path.isfile(p):
            return p
    raise SystemExit('找不到 option.yml，请把它放到 D:\\jmcomic\\option.yml，'
                     '或设置环境变量 JM_OPTION 指向它')


def base_dir():
    """从 option.yml 读下载根目录，读不到就用默认值。"""
    try:
        from jmcomic import create_option
        return create_option(option_path()).dir_rule.base_dir
    except SystemExit:
        raise
    except Exception:
        return r'D:\jmcomic\download'


# ---------- 状态读写 ----------

def _job_file(job_id):
    return os.path.join(STATE_DIR, f'{job_id}.json')


def _log_file(job_id):
    return os.path.join(STATE_DIR, f'{job_id}.log')


def load_job(job_id):
    path = _job_file(job_id)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def save_job(rec):
    os.makedirs(STATE_DIR, exist_ok=True)
    tmp = _job_file(rec['job']) + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(rec, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _job_file(rec['job']))


def all_jobs():
    if not os.path.isdir(STATE_DIR):
        return []
    out = []
    for name in os.listdir(STATE_DIR):
        if not name.endswith('.json'):
            continue
        rec = load_job(name[:-5])
        if rec:
            out.append(rec)
    out.sort(key=lambda r: r.get('start', 0), reverse=True)
    return out


# ---------- 进度估算 ----------

IMG_EXT = ('.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.avif')


def count_new_images(root, since):
    """统计 since 之后新增的图片数，用来估进度。"""
    if not root or not os.path.isdir(root):
        return 0
    n = 0
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            if not fn.lower().endswith(IMG_EXT):
                continue
            try:
                if os.path.getmtime(os.path.join(dirpath, fn)) >= since:
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
    if not os.path.isfile(path):
        return []
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            lines = [ln.rstrip() for ln in f.readlines() if ln.strip()]
        return lines[-n:]
    except Exception:
        return []


# ---------- 提交 ----------

def submit(raw_id):
    raw_id = raw_id.strip()
    if not raw_id:
        raise SystemExit('用法：/py jm 123456 或 /py jm p345678')

    kind = 'photo' if raw_id[:1].lower() == 'p' else 'album'
    jm_id = raw_id[1:] if kind == 'photo' else raw_id
    if not jm_id.isdigit():
        raise SystemExit(f'id 必须是数字：{raw_id}')

    # 同一个 id 正在跑就不重复提交
    for rec in all_jobs():
        if rec.get('jm_id') == jm_id and rec.get('kind') == kind and rec.get('status') == 'running':
            return f'这个已经在下了，任务 {rec["job"]}\n用 /py jm 状态 看进度'

    job_id = time.strftime('%m%d%H%M%S') + kind[0] + jm_id[-4:]
    log_path = _log_file(job_id)
    os.makedirs(STATE_DIR, exist_ok=True)

    rec = {
        'job': job_id, 'kind': kind, 'jm_id': jm_id,
        'status': 'running', 'start': time.time(), 'end': None,
        'base_dir': base_dir(), 'error': None,
    }
    save_job(rec)

    cmd = [sys.executable, os.path.abspath(__file__), '--worker', job_id]
    kwargs = {}
    if os.name == 'nt':
        # 脱离控制台 + 独立进程组：机器人那边超时/退出都不影响它
        kwargs['creationflags'] = 0x00000008 | 0x00000200
    with open(log_path, 'ab') as log:
        subprocess.Popen(cmd, cwd=_HERE, stdin=subprocess.DEVNULL,
                         stdout=log, stderr=subprocess.STDOUT,
                         close_fds=True, **kwargs)

    label = '章节' if kind == 'photo' else '本子'
    return (f'已提交：{label} {jm_id}\n任务 {job_id}\n'
            f'保存到 {rec["base_dir"]}\n稍后用 /py jm 状态 看进度')


# ---------- worker（真正下载） ----------

def worker(job_id):
    rec = load_job(job_id)
    if not rec:
        return 1
    try:
        opt_path = option_path()
        os.environ.setdefault('PYTHONIOENCODING', 'utf-8')

        if os.environ.get('JM_WORKER_FAKE') == '1':
            print('[fake] 模拟下载开始', flush=True)
            time.sleep(3)
            print('[fake] 模拟下载完成', flush=True)
        else:
            from jmcomic import create_option, jm_log
            option = create_option(opt_path)
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
    running = [j for j in jobs if j.get('status') == 'running']

    if not jobs:
        return '还没有下载任务。\n用 /py jm 123456 提交一个。'

    lines = []
    for rec in (running or jobs[:1]):
        elapsed = (rec.get('end') or time.time()) - rec['start']
        if rec['status'] == 'running':
            n = count_new_images(rec.get('base_dir'), rec['start'])
            head = f'⏳ 任务 {rec["job"]} 进行中（{human_time(elapsed)}，已下载 {n} 张）'
        elif rec['status'] == 'done':
            n = rec.get('images') or 0
            head = f'✅ 任务 {rec["job"]} 完成（{n} 张，用时 {human_time(elapsed)}）'
        else:
            head = f'⚠️ 任务 {rec["job"]} 失败：{rec.get("error")}'

        lines.append(head)
        lines.append(f'   目标：{rec["kind"]} {rec["jm_id"]}')
        lines.append(f'   目录：{rec.get("base_dir")}')

        tail = tail_text(_log_file(rec['job']), 3)
        if tail:
            lines.append('   最近日志：' + tail[-1][:80])

    if running:
        lines.append(f'\n另有 {len(running) - 1} 个在跑' if len(running) > 1 else '')
    return '\n'.join(x for x in lines if x)


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


def cmd_log(arg):
    if not arg:
        jobs = all_jobs()
        if not jobs:
            return '没有任务可看。'
        arg = jobs[0]['job']
    target = arg.strip()
    for rec in all_jobs():
        if target in (rec['job'], rec['jm_id']):
            lines = tail_text(_log_file(rec['job']), LOG_TAIL)
            if not lines:
                return f'任务 {rec["job"]} 还没写日志。'
            return '\n'.join(lines)[-1400:]
    return f'没找到任务：{target}'


def main(argv):
    if not argv:
        print(__doc__)
        return 1

    cmd = argv[0].strip()
    low = cmd.lower()

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
