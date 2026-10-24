"""OpenAI-compatible async model transport, preserving max reasoning on every retry."""
import asyncio
import re


class ModelError(RuntimeError):
    def __init__(self, message, status=0):
        super().__init__(message)
        self.status = status


def clean_reply(text):
    text = str(text or "").strip()
    # Never forward leaked tool protocols or private reasoning as a chat message.
    if re.search(r"DSML|<\|.*?(?:tool|analysis)|<tool_call|<think>", text, re.I):
        return ""
    return text


class ModelClient:
    def __init__(self, session, *, api_key, base_url, model="deepseek-flash", timeout=180,
                 max_tokens=None, concurrency=2, retries=2, thinking=None):
        self.session, self.api_key, self.base_url, self.model = session, api_key, base_url.rstrip("/"), model
        self.timeout, self.max_tokens, self.retries, self.thinking = timeout, max_tokens, retries, thinking
        self.semaphore = asyncio.Semaphore(max(1, concurrency))

    def payload(self, system, messages, *, unlimited=False, tools=None, temperature=0.7):
        body = {"model": self.model, "messages": [{"role": "system", "content": system}, *messages],
                "stream": False, "temperature": temperature}
        if self.model.lower().startswith("deepseek"):
            body["reasoning_effort"] = "max"
        elif self.model.lower().startswith("qwen") and self.thinking is not None:
            body["enable_thinking"] = bool(self.thinking)
        if self.max_tokens and not unlimited:
            body["max_tokens"] = self.max_tokens
        if tools:
            body["tools"] = tools
        return body

    async def raw(self, system, messages, **options):
        import aiohttp
        body = self.payload(system, messages, **options)
        if not self.api_key:
            raise ModelError("模型API Key未配置")
        async with self.semaphore:
            for attempt in range(self.retries + 1):
                try:
                    async with self.session.post(self.base_url + "/chat/completions", json=body,
                            headers={"Authorization": f"Bearer {self.api_key}"},
                            timeout=aiohttp.ClientTimeout(total=self.timeout or None)) as response:
                        data = await response.json(content_type=None)
                        if response.status >= 400:
                            code = str((data.get("error") or {}).get("code", ""))
                            # Do not expose API credentials or a provider's echoed request body.
                            raise ModelError(f"模型请求失败 HTTP {response.status} {code}", response.status)
                        choice = (data.get("choices") or [{}])[0]
                        if choice.get("finish_reason") == "length":
                            raise ModelError("模型输出被服务商截断，不发送半篇回答")
                        return choice.get("message", {})
                except (aiohttp.ClientError, TimeoutError, ModelError) as exc:
                    retryable = not isinstance(exc, ModelError) or exc.status == 429 or exc.status >= 500
                    if not retryable or attempt == self.retries:
                        raise
                    await asyncio.sleep(min(2 ** attempt, 16))

    async def chat(self, system, messages, **options):
        message = await self.raw(system, messages, **options)
        return clean_reply(message.get("content", ""))

    async def describe(self, system, text, images):
        return await self.chat(system, [{"role": "user", "content": [{"type": "text", "text": text},
            *({"type": "image_url", "image_url": {"url": image}} for image in images)]}])
