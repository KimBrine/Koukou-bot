"""Tiny native SDK: decorated functions receive arguments and return text or a Result."""
from dataclasses import dataclass, field
import inspect
import json
import sys


@dataclass
class Result:
    text: str = ""
    images: list[str] = field(default_factory=list)
    files: list[str] = field(default_factory=list)


class Plugin:
    def __init__(self):
        self.handler = None

    def command(self, function=None):
        def register(fn):
            if self.handler is not None:
                raise ValueError("一个插件只能注册一个入口函数；子指令可在函数内处理")
            self.handler = fn
            return fn
        return register(function) if function else register

    def run(self, argv=None):
        if self.handler is None:
            raise RuntimeError("未注册插件入口")
        args = list(sys.argv[1:] if argv is None else argv)
        result = self.handler(args)
        if inspect.isawaitable(result):
            import asyncio
            result = asyncio.run(result)
        if isinstance(result, Result):
            from dataclasses import asdict
            print("@@KOUKOU@@" + json.dumps(asdict(result), ensure_ascii=False))
        elif result is not None:
            print(str(result))


plugin = Plugin()
