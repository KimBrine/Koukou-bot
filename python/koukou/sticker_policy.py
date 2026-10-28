"""One image lottery per confirmed text reply; explicit requests bypass that lottery."""
import random
import re
import time
from .messages import chat_key


def user_asks_for_sticker(text):
    text = re.sub(r'\[(?:贴纸|索要表情包)[^\]]*\]', '', str(text or ''))
    if re.search(r'不要|别发|不用发|不必发|不能发|没让.*发|(?:概率|规则|功能|为何|为什么|怎么).{0,12}(?:表情包|贴纸)|(?:分析|识别|看看|评价).{0,8}(?:图|表情)', text):
        return False
    return bool(re.search(r'(?:给我|帮我|请|麻烦|来|发|整|要|换).{0,10}(?:表情包|贴纸|表情|图片|图)', text))


def claims_sticker_delivery(text):
    return bool(re.search(r'(?:表情包|图片|图).{0,12}(?:来[啦了咯]|发[出送给]|拿去|收好)|(?:发[出送给]|给你发|拿去|收好).{0,12}(?:图|表情包)', str(text or '')))


class StickerPolicy:
    def __init__(self, config, libraries, rand=random.random, now=time.time):
        self.config, self.libraries, self.rand, self.now, self.last = config, libraries, rand, now, {}

    def key(self, event):
        key = chat_key(event)
        return self.libraries.scope(key)['key']+':'+key

    def allowed(self, event, store=None, require_library=True):
        if not self.config.enabled('STICKERS_ENABLED'):
            return False
        store = store or self.libraries.for_chat(chat_key(event))
        if require_library and not store.items:
            return False
        scope, private = self.config.get('STICKER_SEND_SCOPE', 'all'), not event.get('group_id')
        return private if scope == 'private' else not private and int(event['group_id']) in self.config.ids('WHITELIST_GROUPS') if scope == 'whitelist' else not private and int(event['group_id']) in self.config.ids('STICKER_SEND_GROUPS') if scope == 'selected' else scope == 'all'

    def select(self, event, *, text, queries=(), context='', requested=False, store=None):
        store = store or self.libraries.for_chat(chat_key(event))
        if not str(text or '').strip():
            return {'items': [], 'reason': '没有已发送文字'}
        if not self.allowed(event, store):
            return {'items': [], 'reason': '开关或发送范围限制'}
        if not self.cooled(event):
            return {'items': [], 'reason': '会话配图冷却'}
        rate = min(1, max(0, self.config.number('STICKER_AUTO_RATE', 35)/100))
        if not requested and (rate <= 0 or self.rand() >= rate):
            return {'items': [], 'reason': '未命中配图概率'}
        limit = max(1, min(3, int(self.config.number('STICKER_MAX_PER_REPLY', 1))))
        mode = self.config.get('STICKER_PICK_MODE', 'context')
        source = '用户配置随机模式' if mode == 'random' else '模型候选按匹配程度加权抽取'
        items = [] if mode == 'random' else store.choose(list(queries), limit=limit, rand=self.rand)
        if not items and (mode == 'random' or requested):
            item = store.random(self.rand) if mode == 'random' else store.pick(context+' '+text, self.rand)
            source = source if mode == 'random' else '明确索图的语境/随机候选'
            if item:
                items = [item]
        items = list({v['id']: v for v in items}.values())[:limit]
        return {'items': items, 'source': source, 'reason': ('明确索图请求' if requested else '文字配图') if items else '模型没有选中合适的库内图片，不补图'}

    def cooled(self,event):
        return self.now()-self.last.get(self.key(event),-float('inf')) >= self.config.number('STICKER_COOLDOWN_SECONDS',0)

    def begin(self, event):
        self.last[self.key(event)] = self.now()
        if len(self.last) > 1000:
            self.last.pop(next(iter(self.last)))
