"""Evidence-aware report inspection; one repair, never fabricate to satisfy a quota."""
from collections import defaultdict
import asyncio
import re
from .summary_basics import content_profile, parse_summary_format, section_heading, topic_policy
from .forward_records import transient_error


def limit_references(text):
    if '〔参考〕' not in text:
        return text
    parsed = parse_summary_format(text)
    section, out = None, []
    for block in parsed['blocks']:
        section = section_heading(block.split('\n')[0]) or section
        if section != 'topics':
            out.append(block); continue
        lines = block.split('\n')
        at = next((i for i, line in enumerate(lines) if re.match(r'^\s*参与者\s*[:：]', line)), None)
        if at is None:
            out.append(re.sub(r'〔/?参考〕', '', block)); continue
        body = '\n'.join(lines[at+1:])
        primary = re.sub(r'〔参考〕[\s\S]*?〔/参考〕|\s', '', body)
        remaining = min(60, len(primary)//4)
        def replace(match):
            nonlocal remaining
            sentence = match[1]
            size = len(re.sub(r'\s', '', sentence))
            if size > remaining:
                return ''
            remaining -= size
            return sentence
        body = re.sub(r'〔参考〕([\s\S]*?)〔/参考〕', replace, body)
        body = re.sub(r'〔参考〕[^\n]*|〔/?参考〕', '', body).strip()
        out.append('\n'.join([*lines[:at+1], body]))
    return '\n\n'.join(out)


def inspect_quality(text, records, stats, profile=None):
    profile = content_profile(records) if profile is None else profile
    parsed, topics = parse_summary_format(text), topic_policy(profile)
    n = profile['ordinaryCount']
    target, minimum_body, average = ('300～500', 180, 240) if n >= 2000 else ('260～450', 150, 210) if n >= 800 else ('220～400', 110, 170)
    detail = {'target': target, 'minBody': minimum_body, 'average': average, 'check': not topics['sparse'] and not profile['forwardOnly'] and profile['evidenceChars'] >= topics['target']*300}
    minimum = {'topics': topics['min'] if n else 0, 'members': min(4, max(1, stats.get('people') or 1)), 'quotes': 0 if profile['forwardOnly'] or not n else 3 if n >= 20 else 1}
    issues, suggestions, bodies = [], [], []
    if parsed['headings'] != ['topics', 'members', 'quotes']:
        issues.append('三个小节必须各出现一次，并按热门话题、群友称号、群圣经的顺序排列')
    for field, name in [('topics', '热门话题'), ('members', '群友称号'), ('quotes', '群圣经')]:
        if parsed['counts'][field] < minimum[field]:
            issues.append(f"{name}只有 {parsed['counts'][field]} 项，应至少 {minimum[field]} 项")
    if parsed['counts']['topics'] > topics['max'] or not n and parsed['counts']['topics']:
        issues.append('热门话题数量超过本期有证据的讨论规模')
    if parsed['counts']['members'] > 5:
        issues.append('群友称号最多5项')
    if profile['forwardOnly'] and parsed['counts']['quotes']:
        issues.append('转发内层原话不能当作本群群圣经')
    aliases = defaultdict(list)
    for person in profile['people']:
        for name in person['names']:
            aliases[name].append(person)
    section = None
    for block in parsed['blocks']:
        section = section_heading(block.split('\n')[0]) or section
        if section == 'quotes':
            match = re.search(r'^\s*\d+[.、．]\s*["“「『]([\s\S]*?)["”」』]\s*[—－–-]{1,3}\s*(\S[^\n]*)', block, re.M)
            if match and not any(match[1] in r.get('text', '') and match[2].strip() in [r.get('name'), r.get('userId')] for r in records):
                issues.append('群圣经原话或说话人未在本群原始记录中核对上')
        if section != 'topics':
            continue
        lines = block.split('\n')
        at = next((i for i, line in enumerate(lines) if re.match(r'^\s*参与者\s*[:：]', line)), None)
        if at is None:
            continue
        title = next((line for line in lines if re.match(r'^\s*\d+[.、．]', line)), '')
        body = re.sub(r'〔参考〕[\s\S]*?〔/参考〕', '', '\n'.join(lines[at+1:])).strip()
        bodies.append(len(re.sub(r'\s', '', body)))
        if not body:
            issues.append('话题缺少正文')
        if n >= 50 and sum(not p['bot'] for p in profile['people']) >= 3:
            remaining = re.sub(r'^\s*参与者\s*[:：]', '', lines[at]); humans, bots = set(), set()
            for name in sorted(aliases, key=len, reverse=True):
                if name not in remaining:
                    continue
                if len(aliases[name]) == 1:
                    person = aliases[name][0]
                    (bots if person['bot'] else humans).add(person['userId'])
                remaining = remaining.replace(name, ' ')
            if re.search('群成员|大家|众人|多人|全体|其他群友', remaining):
                issues.append('话题参与者不能使用无具名证据的统称')
            if not humans and bots:
                issues.append('只有机器人播报不能作为热门讨论')
            elif len(humans) == 1 and not re.search('通知|公告|报名|安排|截止|决定|结果|提醒', title):
                issues.append('讨论充足时不能用单人内容凑热门话题')
        if profile['minorPigRoutine'] and re.search('猪猪|猪圈|养猪|收集.*猪|猪.*收集', title):
            issues.append('少量例行猪猪打卡不单列热门话题')
        if profile['forwardCount'] and re.fullmatch(r'\s*\d+[.、．]\s*(?:合并聊天记录|聊天记录(?:分享|解读|转发|内容)?|转发(?:分享|内容(?:解读|分享)?|记录)|瓜条(?:分享|转发|解读))\s*', title):
            issues.append('转发材料不能单列为群内热门话题')
    if detail['check'] and bodies:
        thin = sum(size < minimum_body for size in bodies)
        if thin > max(1, len(bodies)//4) or sum(bodies)/len(bodies) < average:
            suggestions.append(f'主要话题正文过薄；每项约{target}字，补充有原始记录支持的观点、回应和结果，不编造或凑字')
    return {'ok': not issues and not suggestions, 'counts': parsed['counts'], 'min': minimum, 'topicPolicy': topics, 'detailPolicy': detail,
            'topicBodies': bodies, 'fatalIssues': issues, 'issues': issues+suggestions}


async def generate_checked(model, prompt, messages, records, stats, profile=None, *, pause=asyncio.sleep):
    profile = content_profile(records) if profile is None else profile
    async def request(messages):
        from .models import ModelClient
        options = {'unlimited': profile.get('unrestricted', True)}
        if isinstance(model, ModelClient):
            options['stream'] = True
        try:
            return await model.chat(prompt, messages, **options)
        except Exception as error:
            if not transient_error(error):
                raise
            await pause(.7)
            return await model.chat(prompt, messages, **options)
    text = limit_references(await request(messages))
    quality = inspect_quality(text, records, stats, profile)
    if quality['ok']:
        return text
    accepted, accepted_quality = text, quality
    try:
        text = limit_references(await request([*messages, {'role': 'assistant', 'content': text}, {'role': 'user', 'content': '请基于同一份真实记录完整重写三个小节，修复：'+'；'.join(quality['issues'])+'。证据不足时明确说明，不编造话题、参与者、原话或结果；标题和空行按要求排列。'}]))
    except Exception as error:
        if re.search('DataInspectionFailed|data_inspection_failed|content_filter|content_policy_violation', str(error), re.I) and not accepted_quality['fatalIssues']:
            return accepted
        raise
    quality = inspect_quality(text, records, stats, profile)
    if quality['fatalIssues']:
        raise ValueError('总结修正后仍不完整：'+'；'.join(quality['fatalIssues']))
    return text
