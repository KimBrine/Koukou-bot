"""Resolve only topic QQ references using observed aliases and the actual group roster."""
import re
from .summary_basics import parse_summary_format, section_heading

REFERENCE = re.compile(r'\[\s*(?:@|QQ\s*(?:号)?\s*[:：]?\s*)?([0-9]+)\s*\]|(?<![0-9A-Za-z_])(?:@|QQ\s*(?:号)?\s*[:：]?\s*)?([0-9]{5,12})(?![0-9A-Za-z_])', re.I)


def build_name_index(users=(), records=()):
    index = {}
    for person in [*users, *records]:
        uid = str(person.get('userId', ''))
        name = re.sub(r'[\r\n]+', ' ', str(person.get('name') or '')).strip()
        if not re.fullmatch(r'[0-9]+', uid) or not name or name == uid:
            continue
        entry = index.setdefault(uid, {'name': name, 'aliases': []})
        if name not in entry['aliases']:
            entry['aliases'].append(name)
    return index


def topic_blocks(blocks):
    section = None
    for block in blocks:
        section = section_heading(block.split('\n')[0]) or section
        yield block, section == 'topics'


def protected_spans(text, index):
    spans = [(m.start(), m.end()) for m in re.finditer(r'https?://[^\s<>"）)]+', text)]
    for name in {n for entry in index.values() for n in entry['aliases']}:
        for match in re.finditer(re.escape(name), text):
            left = text[match.start()-1:match.start()] if match.start() else ''
            right = text[match.end():match.end()+1]
            if not (re.search(r'[0-9A-Za-z_]', name[0]) and re.search(r'[0-9A-Za-z_]', left) or re.search(r'[0-9A-Za-z_]', name[-1]) and re.search(r'[0-9A-Za-z_]', right)):
                spans.append((match.start(), match.end()))
    return spans


def listed_aliases(participants, index):
    names = sorted(dict.fromkeys(n for entry in index.values() for n in entry['aliases']), key=lambda n: -len(n))
    matched, spans = set(), []
    for name in names:
        for match in re.finditer(re.escape(name), participants):
            left, right = participants[:match.start()].rstrip(), participants[match.end():].lstrip()
            if (not left or re.search('[、,，;；]$', left)) and (not right or re.match('[、,，;；]', right)) and not any(match.start() < b and match.end() > a for a, b in spans):
                matched.add(name); spans.append((match.start(), match.end()))
    return matched


def replace_topic_references(blocks, index):
    result = []
    for block, topic in topic_blocks(blocks):
        if not topic:
            result.append(block); continue
        match = re.search(r'^\s*参与者\s*[:：]([^\n]*)', block, re.M)
        listed = listed_aliases(match[1] if match else '', index)
        spans = protected_spans(block, index)
        def replace(match):
            if any(match.start() < b and match.end() > a for a, b in spans):
                return match[0]
            entry = index.get(match[1] or match[2])
            return next((n for n in entry['aliases'] if n in listed), entry['name']) if entry else match[0]
        result.append(REFERENCE.sub(replace, block))
    return result


async def resolve_summary_names(text, index, onebot, group):
    missing = set()
    for block, topic in topic_blocks(parse_summary_format(text)['blocks']):
        if not topic:
            continue
        spans = protected_spans(block, index)
        for match in REFERENCE.finditer(block):
            uid = match[1] or match[2]
            if len(uid) >= 5 and uid not in index and not any(match.start() < b and match.end() > a for a, b in spans):
                missing.add(uid)
    if not missing:
        return index
    try:
        members = await onebot.api('get_group_member_list', {'group_id': int(group)}, timeout=15)
        index.update(build_name_index(users=[{'userId': m.get('user_id'), 'name': m.get('card') or m.get('nickname')} for m in members if isinstance(m, dict) and str(m.get('user_id')) in missing]))
    except Exception:
        pass  # An unknown identity remains a QQ reference; never infer a nickname.
    return index
