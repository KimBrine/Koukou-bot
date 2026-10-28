"""Completed-only backups and staged startup restore with interruption rollback."""
from datetime import datetime
import hashlib
from pathlib import Path
import re
import shutil
import time
import uuid
from .state import read_json, write_json, write_text

ITEMS = {"memory.json", "memory.json.reset.json", "long-memory.json", "long-memory.json.state.json", "long-memory.json.records",
         "chat-settings.json", "custom-commands.json", "vision-providers.json", "command-center.json", "supervisor-state.json",
         "personas", "stickers", "persona.txt", "poke-replies.txt", "persona-greetings.json", "python-memory-records"}
ITEMS |= {'native-media-delivery.json', 'native-summary-receipts.json', 'native-poke-delivery.json',
          'custom-command-delivery.json', 'daily-ping-delivery.json', 'daily-ping-state.json',
          'summary-delivery-state.json', 'summary-progress.json', 'native-id-check.json', 'notifications.json',
          'native-reply-delivery.json', 'native-link-delivery.json'}
RECEIPTS = {'native-media-delivery.json','native-summary-receipts.json','native-poke-delivery.json',
            'native-action-delivery.json','native-reply-delivery.json','native-link-delivery.json',
            'custom-command-delivery.json','daily-ping-delivery.json','daily-ping-state.json',
            'summary-delivery-state.json','native-id-check.json','notifications.json','quiet-greetings-state.json'}
ITEMS |= RECEIPTS
NAME = re.compile(r"\d{8}-\d{6}(?:-[a-f0-9]{8})?")


def allowed(name):
    return isinstance(name, str) and (name in ITEMS or bool(re.fullmatch(r'(?:memory|long-memory)__[^/\\<>:"|?*]+\.json', name)))


def child(root, name):
    root = Path(root).absolute()
    if not isinstance(name, str) or name in {".", "..", ""} or Path(name).name != name or "/" in name or "\\" in name:
        raise ValueError("备份路径越界")
    path = root / name
    if path.resolve().parent != root.resolve():
        raise ValueError("备份路径越界")
    return path


def safe_tree(path):
    path = Path(path)
    st = path.lstat()
    if path.is_symlink() or getattr(st, "st_file_attributes", 0) & 0x400:
        raise ValueError("备份不支持符号链接或重解析目录")
    if path.is_dir():
        for entry in path.iterdir():
            safe_tree(entry)


def copy(source, target):
    safe_tree(source)
    if source.is_dir():
        shutil.copytree(source, target)
    else:
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)


def remove(root, name):
    path = child(root, name)
    if path.exists():
        safe_tree(path)
        # Resolve and validate the absolute destination before any recursive deletion.
        if path.resolve().parent != Path(root).resolve():
            raise ValueError("拒绝删除越界备份")
        if path.is_dir():
            shutil.rmtree(path)
        else:
            path.unlink()


def hashes(root, items):
    out = {}
    for name in items:
        base = child(root, name)
        safe_tree(base)
        for file in ([base] if base.is_file() else sorted(base.rglob("*"))):
            if file.is_file():
                with file.open("rb") as stream:
                    h = hashlib.sha256()
                    while block := stream.read(1024*1024):
                        h.update(block)
                out[file.relative_to(root).as_posix()] = h.hexdigest()
    return out


def validate_content(root, items):
    from .memory import validate_recent, validate_long
    for item in items:
        file = child(root, item)
        if file.is_file() and file.suffix == '.json':
            value = read_json(file)
            if item == 'memory.json':
                validate_recent(value)
            elif item == 'long-memory.json':
                validate_long(value)
            elif item.startswith(('memory__', 'long-memory__')):
                if not isinstance(value, dict):
                    raise ValueError('人格记忆分区格式无效')
                (validate_recent if item.startswith('memory__') else validate_long)(value.get('chats'))
            elif item == 'chat-settings.json' and not isinstance(value, dict):
                raise ValueError('会话设置格式无效')
            elif item == 'custom-commands.json':
                from .custom import clean
                if not isinstance(value, list) or len(value) > 200:
                    raise ValueError('自定义指令格式无效')
                for command in value:
                    clean(command)
            elif item == 'command-center.json' and (not isinstance(value, dict) or value.get('version') != 1 or not isinstance(value.get('builtins'), dict)):
                raise ValueError('指令中心格式无效')


def conversation_group(key):
    """Use the same positive, lossless numeric identities as the original console."""
    if not isinstance(key, str) or not re.fullmatch(r'[gp][0-9]{1,15}', key) or not 0 < int(key[1:]) <= 2**53-1:
        raise ValueError('会话编号无效')
    return str(int(key[1:])) if key[0] == 'g' else None


class ConversationDeletion:
    """Pin report originals before a recoverable conversation-file transaction.

    Ordinary backups intentionally do not copy the entire daily archive. Deleting
    a conversation instead keeps just its originals in a separate private backup.
    The original folder is renamed, never recursively deleted; an interrupted
    operation restores both the session before-image and those exact originals.
    """
    def __init__(self, config):
        self.config = config
        self.pending = config.data_dir/'conversation-delete-pending.json'
        self.parent = config.data_dir/'config-backups'
        self.daily = config.data_dir/'daily'
        self.job, self.stage = None, None

    def prepare(self, keys):
        if self.pending.exists():
            raise RuntimeError('存在未完成的会话删除，请重启恢复后再试')
        groups = sorted({group for key in keys if (group := conversation_group(key)) is not None})
        if self.daily.exists(): safe_tree(self.daily)
        if self.parent.exists(): safe_tree(self.parent)
        present = []
        for group in groups:
            source = child(self.daily, group)
            if source.exists():
                if not source.is_dir(): raise ValueError('群归档路径不是目录')
                safe_tree(source); present.append(group)
        if not present:
            return None
        name = 'deleted-chats-'+uuid.uuid4().hex
        self.stage = child(self.parent, name)
        originals = self.stage/'daily'
        originals.mkdir(parents=True)
        try:
            for group in present:
                copy(child(self.daily, group), child(originals, group))
            self.job = {'version':1,'stage':name,'groups':present,'phase':'prepared',
                        'hashes':hashes(originals,present),'before':None}
            if hashes(self.daily,present)!=self.job['hashes']:
                raise ValueError('复制期间群归档已变化，未删除任何记录')
            write_json(self.stage/'deletion.json',self.job)
            write_json(self.pending,self.job)
        except BaseException:
            remove(self.parent,name)
            raise
        return str(originals)

    def stage_archives(self, transaction):
        if self.job is None: return
        if not isinstance(transaction,dict) or transaction.get('version')!=1 or transaction.get('phase')!='prepared' or not isinstance(transaction.get('before'),dict):
            raise ValueError('缺少会话删除事务的恢复信息')
        self.job.update(phase='removing',before=transaction['before'])
        write_json(self.pending,self.job)
        if hashes(self.stage/'daily',self.job['groups'])!=self.job['hashes']:
            raise ValueError('归档备份完整性校验失败，未删除原始记录')
        if hashes(self.daily,self.job['groups'])!=self.job['hashes']:
            raise ValueError('备份后群归档已变化，未删除原始记录')
        moved=self.stage/'removed'
        moved.mkdir()
        for group in self.job['groups']:
            source=child(self.daily,group)
            # Validate the full checked absolute target again immediately before move.
            safe_tree(source)
            if source.resolve().parent!=self.daily.resolve(): raise ValueError('群归档路径越界')
            source.rename(child(moved,group))

    def complete(self):
        if self.job is None: return
        self.job['phase']='complete'
        write_json(self.pending,self.job)
        write_json(self.stage/'deletion.json',self.job)
        self.pending.unlink()

    def rollback_archives(self):
        if self.job is None: return
        _recover_conversation_deletion(self.config,self.pending,self.job,restore_sessions=False)


def _recover_conversation_deletion(config, pending, job, *, restore_sessions):
    from .sessions import transaction_path
    if not isinstance(job,dict) or job.get('version')!=1 or not re.fullmatch(r'deleted-chats-[a-f0-9]{32}',str(job.get('stage',''))) or job.get('phase') not in {'prepared','removing','complete'}:
        raise ValueError('会话删除恢复信息损坏')
    groups=job.get('groups')
    if not isinstance(groups,list) or not groups or len(groups)!=len(set(groups)) or any(not isinstance(g,str) or not re.fullmatch(r'[1-9][0-9]{0,14}',g) for g in groups):
        raise ValueError('会话删除归档范围无效')
    stage=child(config.data_dir/'config-backups',job['stage'])
    safe_tree(stage)
    if hashes(stage/'daily',groups)!=job.get('hashes'):
        raise ValueError('会话删除备份校验失败，请保留备份并人工核对')
    if job['phase']=='complete':
        pending.unlink(); return True
    before=job.get('before')
    if before is not None:
        if not isinstance(before,dict): raise ValueError('会话删除恢复信息损坏')
        # Validate every destination before touching any session file.
        for label,content in before.items():
            transaction_path(config,label)
            if content is not None and not isinstance(content,str): raise ValueError('会话删除恢复内容无效')
    daily=config.data_dir/'daily'
    if daily.exists(): safe_tree(daily)
    for group in groups:
        source=child(daily,group); removed=child(stage/'removed',group)
        if removed.exists():
            safe_tree(removed)
            if source.exists(): raise ValueError('删除恢复目标已出现新归档，拒绝覆盖')
        elif source.exists():
            expected={name:hash for name,hash in job['hashes'].items() if name.startswith(group+'/')}
            if hashes(daily,[group])!=expected:
                raise ValueError('删除恢复目标归档已变化，拒绝覆盖')
    # No recursive delete is used here; each removed original is moved home intact.
    for group in groups:
        source=child(daily,group); removed=child(stage/'removed',group)
        if removed.exists():
            daily.mkdir(parents=True,exist_ok=True)
            removed.rename(source)
        elif not source.exists():
            copy(child(stage/'daily',group),source)
    if restore_sessions and before is not None:
        for label,content in before.items():
            target=transaction_path(config,label)
            if content is None: target.unlink(missing_ok=True)
            else: write_text(target,content)
    job['phase']='rolled-back'
    write_json(stage/'deletion.json',job)
    pending.unlink()
    return True


def recover_conversation_deletion(config):
    """Call with bot.lock owned, before recover_session and mutable services."""
    pending=config.data_dir/'conversation-delete-pending.json'
    job=read_json(pending)
    return False if job is None else _recover_conversation_deletion(config,pending,job,restore_sessions=True)


class Backup:
    def __init__(self, config):
        self.config, self.data = config, config.data_dir
        self.root = self.data / "backups"
        if self.root.exists():
            safe_tree(self.root)

    def list(self):
        if not self.root.exists():
            return []
        result = []
        for path in self.root.iterdir():
            if not NAME.fullmatch(path.name) or not path.is_dir():
                continue
            safe_tree(path)
            meta = read_json(path / "backup.json", {})
            result.append({"name": path.name, "dir": str(path), "size": sum(f.stat().st_size for f in path.rglob("*") if f.is_file()), "at": meta.get("at", 0)})
        return sorted(result, key=lambda x: (x["at"], x["name"]), reverse=True)

    def run(self, reason="manual", keep=7):
        self.root.mkdir(parents=True, exist_ok=True)
        safe_tree(self.root)
        id = uuid.uuid4().hex
        name = datetime.now().strftime("%Y%m%d-%H%M%S")+"-"+id[:8]
        stage, target = child(self.root, ".incomplete-"+id), child(self.root, name)
        stage.mkdir()
        items = sorted(p.name for p in self.data.iterdir() if allowed(p.name))
        try:
            for item in items:
                copy(child(self.data, item), child(stage, item))
            write_json(stage / "backup.json", {"version": 2, "at": time.time()*1000, "reason": reason,
                       "items": items, "persona": self.config.get("ACTIVE_PERSONA"), "hashes": hashes(stage, items)})
            stage.rename(target)
        except BaseException:
            remove(self.root, stage.name)
            raise
        for old in [entry for entry in self.list() if entry["name"] != name][max(1, int(keep))-1:]:
            remove(self.root, old["name"])
        return {"name": name, "dir": str(target), "copied": len(items)}

    def queue_restore(self, name):
        if not isinstance(name, str) or not NAME.fullmatch(name):
            raise ValueError("备份名称无效")
        pending = self.data / "restore-pending.json"
        if pending.exists():
            raise ValueError("已有待恢复任务")
        source = child(self.root, name)
        safe_tree(source)
        meta = read_json(source / "backup.json", {})
        if meta.get("version") != 2 or not isinstance(meta.get("items"), list) or any(not allowed(n) for n in meta["items"]):
            raise ValueError("备份缺少有效完整性信息")
        if meta.get("persona") != self.config.get("ACTIVE_PERSONA"):
            raise ValueError("请先切换到此备份所用人格")
        actual = hashes(source, meta["items"])
        validate_content(source, meta['items'])
        if meta.get("hashes") is not None and meta["hashes"] != actual:
            raise ValueError("备份内容校验失败")
        stage_name = "restore-"+str(uuid.uuid4())
        stage = child(self.data / "config-backups", stage_name)
        (stage / "content").mkdir(parents=True)
        for item in meta["items"]:
            copy(child(source, item), child(stage / "content", item))
        before = self.run("还原前自动备份")
        write_json(pending, {"version": 1, "phase": "queued", "stage": stage_name, "items": meta["items"],
                            "source": name, "before": before["name"], "persona": meta["persona"], "hashes": actual})
        return {"ok": True, "pending": True, "restored": name, "before": before["name"]}

    def apply_pending(self):
        """Caller must own bot.lock; mutable services must not yet have been loaded."""
        pending = self.data / "restore-pending.json"
        job = read_json(pending)
        if job is None:
            return False
        if job.get("version") != 1 or not re.fullmatch(r"restore-[a-f0-9-]{36}", job.get("stage", "")) or not isinstance(job.get("items"), list) or any(not allowed(n) for n in job["items"]):
            raise ValueError("待恢复任务损坏")
        stage = child(self.data / "config-backups", job["stage"])
        safe_tree(stage)
        rollback = stage / "rollback"
        def revert():
            if not isinstance(job.get("present"), list) or any(n not in job["items"] for n in job["present"]):
                raise ValueError("回滚信息损坏")
            for item in job["present"]:
                safe_tree(child(rollback, item))
            for item in job["items"]:
                remove(self.data, item)
                if item in job["present"]:
                    copy(child(rollback, item), child(self.data, item))
        if job["phase"] == "applying":
            revert(); job["phase"] = "failed"; write_json(pending, job)
            raise RuntimeError("上次还原中断，已回滚；请检查恢复任务")
        if job["phase"] != "queued" or job["persona"] != self.config.get("ACTIVE_PERSONA"):
            raise ValueError("恢复状态或人格不匹配")
        if hashes(stage / "content", job["items"]) != job.get("hashes"):
            raise ValueError("暂存恢复数据校验失败")
        validate_content(stage / 'content', job['items'])
        rollback.mkdir()
        job["present"] = []
        for item in job["items"]:
            source = child(self.data, item)
            if source.exists():
                copy(source, child(rollback, item)); job["present"].append(item)
        job["phase"] = "applying"; write_json(pending, job)
        try:
            for item in job["items"]:
                # An external action cannot be undone by restoring local files.
                # Preserve the latest receipts so a memory rollback never rearms sends.
                if item in RECEIPTS and item in job['present']:
                    continue
                remove(self.data, item)
                copy(child(stage / "content", item), child(self.data, item))
            job["phase"] = "complete"
            write_json(stage / "result.json", job)
            pending.unlink()
            return True
        except BaseException:
            revert(); job["phase"] = "failed"; write_json(pending, job)
            raise
