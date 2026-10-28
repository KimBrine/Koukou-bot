"""Persona-bound fixed greetings. Reading or sending never calls a model."""
from .sessions import digest, persona_text
from .state import read_json, write_json


def validate(value):
    if not isinstance(value, dict):
        raise ValueError("早晚安语库格式错误")
    out = {}
    for key in ("goodmorning", "goodnight"):
        lines = value.get(key)
        if not isinstance(lines, list) or len(lines) > 24:
            raise ValueError("每种问候需要0~24段")
        out[key] = []
        for text in lines:
            if not isinstance(text, str) or not 1 <= len(text.strip()) <= 240 or "[CQ:" in text or "\0" in text:
                raise ValueError("每段问候需要1~240字纯文字")
            if text.strip() not in out[key]:
                out[key].append(text.strip())
    return out


class GreetingLibrary:
    def __init__(self, file):
        self.file = file
        self.state = read_json(file, {"version": 1, "libraries": {}})
        if self.state.get("version") != 1 or not isinstance(self.state.get("libraries"), dict):
            raise ValueError("人格语库损坏")
        for key, value in self.state["libraries"].items():
            import re
            if not re.fullmatch(r"[a-f0-9]{64}", key):
                raise ValueError("语库人格标识无效")
            validate(value)

    def get(self, content):
        library = self.state["libraries"].get(digest(content))
        return {"personaHash": digest(content), **validate(library)} if library is not None else None

    def set(self, content, value):
        persona_text(content)
        library = validate(value)
        if "personaHash" in value and value["personaHash"] != digest(content):
            raise ValueError("语库与人格正文不匹配")
        next = {**self.state, "libraries": {**self.state["libraries"], digest(content): library}}
        write_json(self.file, next)
        self.state = next
        return library
