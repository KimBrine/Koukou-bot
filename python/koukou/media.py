"""Plugin text, cards and file delivery with durable receipts and no ambiguous retries."""
import asyncio
from pathlib import Path
import re
import time
from urllib.parse import unquote, urlsplit
from urllib.request import url2pathname
from .messages import chat_key
from .state import read_json, write_json
from .onebot import confirmed_message_id


class DeliveryUncertain(RuntimeError):
    outcome_unknown = True


def local_path(value):
    text = str(value)
    if text.startswith("file:"):
        parsed = urlsplit(text)
        if parsed.netloc not in {"", "localhost"}:
            raise ValueError("文件URI不能指向远程主机")
        text = url2pathname(unquote(parsed.path))
    return Path(text).expanduser().resolve()


class MediaDelivery:
    def __init__(self, config, onebot, plugins=None, quiet=lambda key: False, now=time.time):
        self.config, self.onebot, self.plugins, self.quiet, self.now = config, onebot, plugins, quiet, now
        self.file = config.data_dir / "native-media-delivery.json"
        self.records = read_json(self.file, {})
        if not isinstance(self.records, dict):
            raise ValueError("媒体投递记录损坏，拒绝重发")

    def save(self):
        self.records = dict(list(self.records.items())[-4000:])
        write_json(self.file, self.records)

    def files(self, result):
        spec = result.get("legacyFile")
        entries = result.get("files", [])
        if spec:
            if not isinstance(spec, dict):
                raise ValueError("文件结果格式无效")
            entries = spec.get("parts") or [{"path": spec.get("path", ""), "name": spec.get("name")}]
        if not isinstance(entries, list) or len(entries) > 100:
            raise ValueError("文件数量或格式无效")
        files = []
        max_bytes = max(1, self.config.number("FILE_UPLOAD_MAX_MB", 1024))*1024*1024
        for entry in entries:
            raw = entry.get("path") if isinstance(entry, dict) else entry
            if not isinstance(raw, str) or not raw.strip():
                raise ValueError("文件路径无效")
            path = local_path(raw)
            if not path.is_file() or path.stat().st_size > max_bytes:
                raise ValueError("文件不存在或超过当前上传上限")
            name = entry.get("name") if isinstance(entry, dict) else None
            name = name or path.name
            if not isinstance(name, str) or any(c in name for c in "/\\\r\n\0"):
                raise ValueError("文件显示名无效")
            files.append({"path": path, "name": name})
        return files, spec or {}

    async def deliver(self, event, result, *, current=lambda: True):
        key = chat_key(event)
        request = f"{self.onebot.self_id}:{key}:{event.get('message_id')}"
        files, spec = self.files(result)  # Validate the entire result before sending anything.
        music = result.get("music")
        if music is not None and (not isinstance(music, dict) or music.get("type") not in {"163", "qq"} or not re.fullmatch(r"\d{1,20}", str(music.get("id", "")))):
            raise ValueError("音乐名片格式无效")
        images = result.get("images", [])
        sticker_images = result.get('stickerImages', [])
        if not isinstance(images, list) or not isinstance(sticker_images, list) or len(images)+len(sticker_images) > 100:
            raise ValueError("图片结果无效")
        for image in images+sticker_images:
            if not isinstance(image, str) or not image:
                raise ValueError("图片路径无效")
            if not image.startswith(("https://", "http://", "data:image/")) and not local_path(image).is_file():
                raise ValueError("图片文件不存在")
        settings = self.plugins.settings() if self.plugins else {"recallEnabled": True, "recallSeconds": 300}
        try:
            seconds = spec["recall_seconds"] if "recall_seconds" in spec else float(spec.get("recall_minutes", settings["recallSeconds"]/60))*60
            seconds = float(seconds)
        except (ValueError, TypeError):
            raise ValueError("撤回时间格式无效")
        if not 0 <= seconds <= 7200:
            raise ValueError("撤回时间必须在0~7200秒内")
        if not settings.get("recallEnabled", True) and not ('recall_seconds' in spec or 'recall_minutes' in spec):
            seconds = 0
        card = result.get("legacyCard")
        if card is not None:
            if not isinstance(card, dict) or not isinstance(card.get("nodes"), list) or not 1 <= len(card["nodes"]) <= 100:
                raise ValueError("聊天记录格式无效")
            for node in card["nodes"]:
                if not isinstance(node, dict) or not isinstance(node.get("images", []), list):
                    raise ValueError("聊天记录节点格式无效")
                if not node.get("text") and not node.get("images"):
                    raise ValueError("聊天记录节点为空")
                for image in node.get("images", []):
                    if not isinstance(image, str) or not image or (not image.startswith(("https://", "http://", "data:image/")) and not local_path(image).is_file()):
                        raise ValueError("聊天记录图片无效")
        alive = lambda: current() and not self.quiet(key)
        step, sent = 0, []

        async def dispatch(send, *, recall=False, message=""):
            nonlocal step
            token = f"{request}:{step}"; step += 1
            if not alive():
                return False
            if token in self.records:
                return False
            record = {"key": key, "selfId": str(self.onebot.self_id), "at": self.now(), "status": "reserved"}
            self.records[token] = record; self.save()
            try:
                receipt = await send()
                mid = confirmed_message_id(receipt)
                if mid is None:
                    record["status"] = "uncertain"; self.save()
                    return False
                record.update(status="confirmed", messageId=str(mid))
                if recall and seconds:
                    record.update(recallAt=self.now()+seconds, recallStatus="pending")
                try:
                    self.save()
                except Exception as error:
                    raise DeliveryUncertain('QQ已返回回执，但投递记录未能保存；请核对目标会话，不自动重发') from error
                sent.append({"messageId": str(mid), "text": message})
                return True
            except asyncio.CancelledError:
                record["status"] = "uncertain"
                try: self.save()
                except Exception: pass
                raise
            except Exception:
                record["status"] = "uncertain"
                try: self.save()
                except Exception: pass
                raise

        text = str(result.get("text") or spec.get("text") or spec.get("summary") or "")
        if text and not await dispatch(lambda: self.onebot.send(key, text), message=text):
            return sent
        if music is not None:
            if not await dispatch(lambda: self.onebot.send(key, [{"type": "music", "data": {"type": music["type"], "id": str(music["id"])}}])):
                return sent
        if card:
            nodes = []
            for node in card.get("nodes", []):
                content = []
                if node.get("text"):
                    content.append({"type": "text", "data": {"text": str(node["text"])}})
                for image in node.get("images", []):
                    content.append({"type": "image", "data": {"file": str(image)}})
                if content:
                    nodes.append({"type": "node", "data": {"name": self.config.get("BOT_NAME", "小助手"), "uin": self.onebot.self_id, "content": content}})
            if not nodes:
                raise ValueError("聊天记录内容为空")
            action, id_field = ("send_group_forward_msg", "group_id") if key.startswith("g") else ("send_private_forward_msg", "user_id")
            if not await dispatch(lambda: self.onebot.api(action, {id_field: int(key[1:]), "messages": nodes}, timeout=120)):
                return sent
        if images:
            segments = []
            for image in images:
                file = image if image.startswith(("http://", "https://", "data:")) else local_path(image).as_uri()
                segment = await self.onebot.image_segment(file) if hasattr(self.onebot, 'image_segment') else {'type':'image','data':{'file':file}}
                segments.append(segment)
            if not await dispatch(lambda: self.onebot.send(key, segments)):
                return sent
        if sticker_images:
            segments = []
            for image in sticker_images:
                segment = await self.onebot.image_segment(image, sticker=True) if hasattr(self.onebot, 'image_segment') else {'type':'image','data':{'file':image,'sub_type':1,'subType':1}}
                segments.append(segment)
            if not await dispatch(lambda: self.onebot.send(key, segments)):
                return sent
        for file in files:
            # File segments return message IDs and can be recalled. Only explicitly unsupported
            # segments may fall back to the file API, whose success has no recallable ID.
            segment = [{"type": "file", "data": {"file": file["path"].as_uri(), "name": file["name"]}}]
            try:
                if not await dispatch(lambda segment=segment: self.onebot.send(key, segment, timeout=600), recall=True):
                    return sent
            except Exception as error:
                if getattr(error, "outcome_unknown", False) or not re.search(r"unsupported|not implemented|unknown.*(?:segment|type)|file.*segment|不支持.*文件", str(error), re.I):
                    raise
                if not alive():
                    return sent
                token = f"{request}:upload:{step}"; step += 1
                if token in self.records:
                    return sent
                fallback = {"key": key, "selfId": str(self.onebot.self_id), "at": self.now(), "status": "reserved", "recallStatus": "unsupported"}
                self.records[token] = fallback; self.save()
                try:
                    await self.onebot.api("upload_group_file" if key.startswith("g") else "upload_private_file",
                        {"group_id" if key.startswith("g") else "user_id": int(key[1:]), "file": str(file["path"]), "name": file["name"]}, timeout=600)
                    fallback["status"] = "confirmed"; self.save()
                    sent.append({"messageId": None, "text": "文件API上传已确认，无法自动撤回"})
                except BaseException:
                    fallback["status"] = "uncertain"; self.save(); raise
        return sent

    async def cleanup(self):
        for record in self.records.values():
            if record.get("recallStatus") != "pending" or record.get("recallAt", float("inf")) > self.now():
                continue
            if str(self.onebot.self_id) != record["selfId"]:
                continue
            if self.quiet(record["key"]):
                record["recallStatus"] = "skippedQuiet"; self.save(); continue
            # An uncertain delete is never automatically repeated.
            record["recallStatus"] = "reserved"; self.save()
            try:
                await self.onebot.api("delete_msg", {"message_id": record["messageId"]})
                record["recallStatus"] = "confirmed"
            except Exception:
                record["recallStatus"] = "uncertain"
            self.save()
