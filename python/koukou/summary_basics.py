"""Summary counts, semantic block boundaries and content budgets ported from JS."""
from bisect import bisect_right
from datetime import datetime
import copy
import math
import re
import time
import uuid
from .messages import TABLES
from .forward_records import CHINA
from .state import read_json, write_json

RANGES = TABLES['extendedPictographic']
STARTS = [r[0] for r in RANGES]


def pictographic(char):
    code = ord(char); index = bisect_right(STARTS, code)-1
    return index >= 0 and code <= RANGES[index][1]


def analyze_text(text):
    text = str(text or '')
    pattern = r'\[表情[:：][^\[\]]{0,12}\]'
    faces = len(re.findall(pattern, text))
    emojis = sum(pictographic(c) for c in text)
    cleaned = re.sub(pattern, '表', text)
    cleaned = re.sub(r'\[(图片|语音|视频|合并聊天记录)\]', '', cleaned)
    return {'chars': sum(not c.isspace() for c in cleaned), 'faces': faces, 'emojis': emojis, 'emojiTotal': faces+emojis}


def summary_stats(records):
    hours, users, chars, emoji = [0]*24, {}, 0, 0
    for record in records:
        counts = analyze_text(record.get('text', ''))
        chars += counts['chars']; emoji += counts['emojiTotal']
        hours[datetime.fromtimestamp(record.get('time') or 0, CHINA).hour] += 1
        key = str(record.get('userId', record.get('name', '?')))
        user = users.setdefault(key, {'userId': key, 'name': str(record.get('name', key)), 'count': 0, 'chars': 0, 'emoji': 0, 'replies': 0})
        user['count'] += 1; user['chars'] += counts['chars']; user['emoji'] += counts['emojiTotal']; user['replies'] += bool(record.get('replyId'))
    for user in users.values():
        for field, numerator, places in [('avgChars', 'chars', 10), ('emojiRatio', 'emoji', 100), ('replyRatio', 'replies', 100)]:
            user[field] = math.floor(user[numerator]/user['count']*places+.5)/places
    people = sorted(users.values(), key=lambda u: (-u['count'], -u['chars']))
    peak = hours.index(max(hours)) if records else -1
    return {'total': len(records), 'people': len(people), 'chars': chars, 'emoji': emoji, 'peak': f'{peak:02}:00-{(peak+1)%24:02}:00' if peak >= 0 else '—', 'hourHistogram': hours, 'users': people}


def section_heading(line):
    match = re.fullmatch(r'(?:#{1,6}\s*)?(?:💬|🏆)?\s*(热门话题|群友称号|群圣经)\s*[：:]?\s*', line.strip())
    return {'热门话题': 'topics', '群友称号': 'members', '群圣经': 'quotes'}.get(match[1]) if match else None


def parse_summary_format(text):
    normalized = str(text or '').replace('\r\n', '\n').replace('\r', '\n')
    lines = normalized.split('\n')
    headings, counts, blocks = [], {'topics': 0, 'members': 0, 'quotes': 0}, []
    decode = lambda s: re.sub(r'\\r\\n|\\n|\\r', '\n', s)
    if not any(section_heading(line) for line in lines):
        return {'headings': headings, 'counts': counts, 'blocks': [decode(s.strip()) for s in re.split(r'\n[ \t]*\n+', normalized) if s.strip()]}
    section, current, title, has_entry, quoted = None, [], '', False, False
    def flush():
        block = '\n'.join(current).strip()
        if block:
            blocks.append(decode(block))
        current.clear()
    for index, line in enumerate(lines):
        trimmed = line.strip()
        heading = section_heading(line) if not quoted else None
        if heading:
            flush()
            if title:
                blocks.append(title)
            title, section, has_entry = trimmed, heading, False
            headings.append(heading)
            continue
        next_text = next((line.strip() for line in lines[index+1:] if line.strip()), '')
        numbered = re.match(r'^\d+[.、．]\s*\S', trimmed)
        topic = section == 'topics' and numbered and re.match(r'^参与者\s*[:：]', next_text)
        member = section == 'members' and re.match(r'^[•●]\s*.+?\s+[-－—–]\s*\S', trimmed)
        quote = section == 'quotes' and re.match(r'^\d+[.、．]\s*["“「『]', trimmed)
        entry = not quoted and (topic or member or quote)
        if entry:
            if has_entry:
                flush()
            if title:
                current.append(title); title = ''
            has_entry = True; counts[section] += 1
            if quote:
                opening = re.search(r'["“「『]', trimmed).start()
                quoted = re.search(r'["”」』]\s*[—－–-]{1,3}\s*\S', trimmed[opening+1:]) is None
        elif quoted and re.search(r'["”」』]\s*[—－–-]{1,3}\s*\S', trimmed):
            quoted = False
        if not trimmed and not current:
            continue
        if title and trimmed:
            current.append(title); title = ''
        current.append(line)
    flush()
    if title:
        blocks.append(title)
    return {'headings': headings, 'counts': counts, 'blocks': blocks}


def routine_kind(record):
    text = record.get('text', '').strip()
    command = re.sub(r'^(?:\[@\d+\]\s*)+', '', text).strip()
    if re.fullmatch(r'/\s*(?:今日猪猪|我的猪圈)\s*', command):
        return 'pig-command'
    if re.fullmatch(r'/\s*(?:签到|打卡|今日运势|今日老婆|抽签)\s*', command):
        return 'routine-command'
    if re.search(r'不需要@就可以玩[^\r\n]{1,40}的方法', text) and re.search('抓到.*猪猪', text) or re.match(r'^【\s*@.+的猪圈】\s*📦\s*已收集\s*[:：]', text):
        return 'pig-result'
    return None


def meaningful_text(record):
    text = re.sub(r'\[(?:图片|视频|语音|表情|动画表情|合并聊天记录)[^\]]*\]|\[@\d+\]', '', record.get('text', ''))
    return ''.join(c for c in text if not pictographic(c) and c not in '\ufe0f\u200d').strip()


def content_profile(records, bot_users=()):
    bots = set(map(str, bot_users)); people, unique, ordinary, pig = {}, set(), [], []
    counts = {'pig-command': 0, 'pig-result': 0, 'routine-command': 0}
    bot_count, evidence = 0, 0
    for record in records:
        id, name = str(record.get('userId', '')), str(record.get('name', '')).strip()
        if id and name:
            person = people.setdefault(id, {'userId': id, 'names': [], 'bot': id in bots})
            if name not in person['names']:
                person['names'].append(name)
        kind = routine_kind(record)
        if kind:
            counts[kind] += 1; continue
        if id in bots:
            bot_count += 1; continue
        text = meaningful_text(record)
        if len(text) < 2:
            continue
        ordinary.append(record)
        if text not in unique:
            unique.add(text); evidence += min(120, len(text))
        if '猪' in text:
            pig.append(text)
    windows = []
    for record in ordinary:
        at = record.get('time') or 0
        if not isinstance(at, (float, int)) or not math.isfinite(at) or at <= 0:
            continue
        if not windows or at-windows[-1]['end'] > 1200:
            windows.append({'start': at, 'end': at, 'messages': 0, 'users': set()})
        window = windows[-1]; window['end'] = at; window['messages'] += 1; window['users'].add(str(record.get('userId', record.get('name', '?'))))
    forward = lambda r: bool(r.get('forwards') or '[合并聊天记录]' in r.get('text', ''))
    forward_count = sum(forward(r) for r in records)
    pig_routine, pig_chars = counts['pig-command']+counts['pig-result'], sum(map(len, pig))
    return {'total': len(records), 'counts': counts, 'routineCount': sum(counts.values()), 'pigRoutineCount': pig_routine, 'ordinaryCount': len(ordinary),
            'botCount': bot_count, 'evidenceChars': evidence, 'people': list(people.values()), 'forwardCount': forward_count,
            'forwardOnly': bool(forward_count and all(forward(r) for r in ordinary)), 'pigDiscussionCount': len(pig), 'pigDiscussionChars': pig_chars,
            'minorPigRoutine': bool(len(ordinary) >= 50 and pig_routine and pig_routine/len(records) < .2 and len(pig) < 8 and pig_chars < 500),
            'windows': [{k: v for k, v in w.items() if k != 'users'} | {'people': len(w['users'])} for w in windows if w['messages'] >= 3]}


def topic_policy(profile):
    count = max(0, profile.get('ordinaryCount', 0)); sparse = count <= 40
    if profile.get('forwardOnly'):
        return {'meaningful': count, 'sparse': True, 'min': 0, 'target': 0, 'max': 0}
    minimum, target, maximum = (6, 8, 10) if count >= 2000 else (4, 6, 8) if count >= 800 else (3, 4, 6) if count >= 200 else (1 if sparse else 3, 1 if count <= 10 else 2 if sparse else 3, 5)
    return {'meaningful': count, 'sparse': sparse, 'min': minimum, 'target': target, 'max': math.inf if profile.get('unrestricted') else maximum}


class SummaryProgress:
    def __init__(self, file, now=lambda: time.time()*1000):
        self.file, self.now = file, now
        self.items = read_json(file, {})
        if not isinstance(self.items, dict):
            raise ValueError('群总结进度状态损坏')
        changed = False
        for id, item in self.items.items():
            if not str(id).isdecimal() or not isinstance(item, dict) or item.get('status') not in {'idle', 'generating', 'success', 'failed'}:
                raise ValueError('群总结任务格式损坏')
            if item['status'] == 'generating':
                item.update(status='failed', stage='interrupted', message='机器人已重启，上次任务中断；请核对群内是否已发送后再重试。', finishedAt=now()); changed = True
        if changed:
            self.save()

    def save(self):
        write_json(self.file, self.items)

    def get(self, group):
        return copy.deepcopy(self.items.get(str(group), {'groupId': int(group), 'status': 'idle', 'stage': 'idle', 'message': '', 'jobId': '', 'updatedAt': 0}))

    def start(self, group, days=1, scheduled=False):
        item = self.get(group)
        if item['status'] == 'generating':
            return item
        item = {'groupId': int(group), 'jobId': str(uuid.uuid4()), 'status': 'generating', 'stage': 'history', 'message': '正在读取聊天记录', 'days': days, 'scheduled': scheduled, 'startedAt': self.now(), 'updatedAt': self.now(), 'finishedAt': 0}
        self.items[str(group)] = item; self.save()
        return copy.deepcopy(item)

    def update(self, group, job, **patch):
        item = self.get(group)
        if item['jobId'] != job or item['status'] != 'generating':
            return False
        patch.pop('groupId', None); patch.pop('jobId', None)
        item.update(patch, updatedAt=self.now())
        if item['status'] in {'success', 'failed'}:
            item['finishedAt'] = self.now()
        self.items[str(group)] = item; self.save(); return True

    def acknowledge(self, group, job):
        item = self.get(group)
        if item['jobId'] != job or item['status'] not in {'success', 'failed'}:
            return False
        item.update(status='idle', stage='idle', message='', updatedAt=self.now())
        self.items[str(group)] = item; self.save(); return True
