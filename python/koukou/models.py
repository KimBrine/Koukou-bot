"""OpenAI-compatible async model transport, preserving max reasoning on every retry."""
import asyncio
import re
import json


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

    def payload(self, system, messages, *, unlimited=False, tools=None, temperature=0.7, stream=False):
        body = {"model": self.model, "messages": [{"role": "system", "content": system}, *messages],
                "stream": stream, "temperature": temperature}
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
                            timeout=aiohttp.ClientTimeout(total=None, connect=30, sock_read=self.timeout or None) if body['stream'] else aiohttp.ClientTimeout(total=self.timeout or None)) as response:
                        if body['stream'] and response.status < 400 and response.content_type == 'text/event-stream':
                            chunks, finished = [], False
                            async for raw in response.content:
                                line = raw.decode('utf-8').strip()
                                if not line.startswith('data:'):
                                    continue
                                value = line[5:].strip()
                                if value == '[DONE]':
                                    break
                                try:
                                    data = json.loads(value)
                                except ValueError as exc:
                                    raise ModelError('模型流返回无效JSON，未发送半篇回答', 502) from exc
                                if not isinstance(data,dict):
                                    raise ModelError('模型流返回格式无效，未发送半篇回答',502)
                                if data.get('error'):
                                    raise ModelError('模型流错误 content_filter' if re.search('inspection|content|safety',str(data['error']),re.I) else '模型流错误',400)
                                choices=data.get('choices',[])
                                if not isinstance(choices,list):raise ModelError('模型流选择格式无效',502)
                                choice=choices[0] if choices else {}
                                if not isinstance(choice,dict) or not isinstance(choice.get('delta',{}),dict):
                                    raise ModelError('模型流选择格式无效，未发送半篇回答',502)
                                delta = choice.get('delta', {})
                                if delta.get('tool_calls'):
                                    raise ModelError('本轮总结不允许工具调用')
                                content = delta.get('content')
                                if isinstance(content, str):
                                    chunks.append(content)
                                reason = choice.get('finish_reason')
                                if reason == 'length':
                                    raise ModelError('模型输出被服务商截断，不发送半篇回答')
                                if reason in {'content_filter', 'safety'}:
                                    raise ModelError('模型内容检查未通过 content_filter', 400)
                                if reason:
                                    finished = True; break
                            if not finished:
                                raise ModelError('模型流提前中断，未发送半篇回答', 502)
                            return {'content': ''.join(chunks)}
                        try:data = await response.json(content_type=None)
                        except ValueError as error:
                            raise ModelError('模型返回无效JSON',response.status if response.status>=400 else 502) from error
                        if not isinstance(data,dict):raise ModelError('模型响应格式无效',502)
                        if response.status >= 400 or data.get('error'):
                            error=data.get('error') or {}
                            code=re.sub(r'[^A-Za-z0-9_.-]','',str(error.get('code','') if isinstance(error,dict) else ''))[:100]
                            # Do not expose API credentials or a provider's echoed request body.
                            raise ModelError(f"模型请求失败 HTTP {response.status} {code}", response.status if response.status>=400 else 400)
                        choices=data.get('choices')
                        if not isinstance(choices,list) or not choices or not isinstance(choices[0],dict):
                            raise ModelError('模型响应缺少完整回答',502)
                        choice=choices[0]
                        if choice.get("finish_reason") == "length":
                            raise ModelError("模型输出被服务商截断，不发送半篇回答")
                        if choice.get('finish_reason') in {'content_filter','safety'}:
                            raise ModelError('模型内容检查未通过 content_filter',400)
                        message=choice.get('message')
                        if not isinstance(message,dict) or message.get('content') is not None and not isinstance(message['content'],str):
                            raise ModelError('模型回答格式无效',502)
                        return message
                except (aiohttp.ClientError, TimeoutError, ModelError) as exc:
                    retryable = not isinstance(exc, ModelError) or exc.status == 429 or exc.status >= 500
                    if not retryable or attempt == self.retries:
                        raise
                    await asyncio.sleep(min(2 ** attempt, 16))

    async def chat(self, system, messages, **options):
        message = await self.raw(system, messages, **options)
        return clean_reply(message.get("content", ""))

    async def describe(self, system, text, images, **options):
        return await self.chat(system, [{"role": "user", "content": [{"type": "text", "text": text},
            *({"type": "image_url", "image_url": {"url": image}} for image in images)]}], **options)
