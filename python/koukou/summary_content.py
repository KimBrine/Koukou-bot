"""Full-window evidence guide, budget sampling and faithful transcript rendering."""
import math
import re
from datetime import datetime
from .forward_records import CHINA
from .summary_basics import meaningful_text, routine_kind, topic_policy


def detail_policy(profile):
    n, topics = profile.get('ordinaryCount', 0), topic_policy(profile)
    return {'target': '300～500' if n >= 2000 else '260～450' if n >= 800 else '220～400',
            'minBody': 180 if n >= 2000 else 150 if n >= 800 else 110, 'average': 240 if n >= 2000 else 210 if n >= 800 else 170,
            'check': not topics['sparse'] and not profile['forwardOnly'] and profile.get('evidenceChars', 0) >= topics['target']*300}


def format_content_guide(profile):
    total, counts, ordinary = profile['total'], profile['counts'], profile['ordinaryCount']
    topics, detail = topic_policy(profile), detail_policy(profile)
    maximum = f"最多{topics['max']}项" if math.isfinite(topics['max']) else '不设固定条数上限'
    lines = [f"完整窗口 {total} 条；可识别的例行交互 {profile['routineCount']} 条；有实际文字内容的普通聊天 {ordinary} 条（均按消息计数，普通聊天剔除了纯图片/表情和上述例行交互）。",
             f"正文详细程度：主要话题约{detail['target']}字，信息丰富可继续展开，这不是上限。消息越多应保留更多起因、具体分歧、互相回应和实际结果，不能只增加条目却把每项压成几句话。材料不足时据实简写，不凑字、不虚构结论。",
             f"已标记机器人的非例行发言 {profile.get('botCount', 0)} 条，不计为真人来回讨论。机器人名片："+('、'.join(n for p in profile.get('people', []) if p['bot'] for n in p['names']) or '未配置')+'。不能将单个账号的播报算成多人参与；参与者栏不能写“群成员、大家”等统称来充数。',
             f"猪猪例行交互 {profile['pigRoutineCount']} 条（指令 {counts['pig-command']}、固定回复 {counts['pig-result']}），占原始消息 {100*profile['pigRoutineCount']/total if total else 0:.1f}%；此外普通聊天中直接提到「猪」的 {profile['pigDiscussionCount']} 条。这个词命中数不等于完整话题规模。"]
    stamp = lambda sec: datetime.fromtimestamp(sec, CHINA).strftime('%m-%d %H:%M')
    lines.extend(f"- {stamp(w['start'])}～{stamp(w['end'])}：普通文字聊天 {w['messages']} 条、{w['people']} 人；这是时间段统计，不是程序认定的单一话题。" for w in sorted(profile['windows'], key=lambda w: -w['messages'])[:6])
    if profile['forwardOnly']:
        lines.append('本期只有转发参考资料或非文本内容，没有有效群内交流；热门话题不凑数，保留标题并说明暂无足够依据。内层原话不能做本群群圣经。')
    elif topics['sparse']:
        lines.append(f"本期有效普通文字样本只有 {ordinary} 条（不超过40条），允许按证据写1～2项话题，优先{topics['target']}项；原始图片和固定模板条数不代表可总结的讨论量。")
    else:
        lines.append(f"话题数量要求：完整窗口有效普通文字 {ordinary} 条，热门话题至少{topics['min']}项，优先{topics['target']}项，{maximum}；不能只写两项就结束。"+('本期讨论量较大，五项不是上限；不能把不相关的讨论合并为少数宽泛的大标题。' if topics['target'] > 5 else '')+'先通读整个窗口，在心里列出有证据的独立讨论、重要信息、通知、决定与安排，再归并同一事件并按重要性选取。不同问题有各自的交流、结论或后续时分别成题；同一件事跨时段出现则合并。不能为了数量编造或把同一件事机械拆分。')
    lines.append('时间分布用于帮助通读上下文，不规定话题个数；同一时段可以有多个独立主题，同一主题也可能跨越多个时段，不能将两个活跃时段等同于两个话题。')
    if profile['forwardCount']:
        lines.append(f"合并记录外层 {profile['forwardCount']} 条；只按外层消息计数。内层内容只作低权重参考，不能单列转发热门话题，也不能扩大有效文字样本或参与人数。")
    if profile['minorPigRoutine']:
        lines.append('本期普通讨论充足，猪猪只是少量例行交互：不单列热门话题，不用打卡、查库存或机器人模板凑数量；必要时在真正引发交流的相关主话题里用一句话提及。不能编造围观、热潮或后续交流。')
    return '\n'.join(lines)


def select_records(records, budget, bot_users=()):
    cap = max(1, math.floor(budget or len(records)))
    if len(records) <= cap:
        return records
    ordinary, other, bots = [], [], set(map(str, bot_users))
    for i, record in enumerate(records):
        target = ordinary if str(record.get('userId')) not in bots and not routine_kind(record) and len(meaningful_text(record)) >= 2 else other
        target.append(i)
    def sample(indices, count):
        if not count:
            return []
        return indices if count >= len(indices) else [indices[-1]] if count == 1 else [indices[math.floor(i*(len(indices)-1)/(count-1))] for i in range(count)]
    def neighborhoods(indices, count):
        if len(indices) <= count or count < 10:
            return sample(indices, count)
        selected, chunks = set(), math.ceil(count/5)
        for i in range(chunks):
            width = count//chunks+(i < count % chunks)
            start = math.floor(i*(len(indices)-width)/(chunks-1))
            selected.update(indices[start:start+width])
        selected.update(sample([i for i in indices if i not in selected], count-len(selected)))
        return selected
    ordinary_budget = min(len(ordinary), math.ceil(cap*.9) if other else cap)
    other_budget = min(len(other), cap-ordinary_budget)
    regular_budget = min(len(ordinary), cap-other_budget)
    return [records[i] for i in sorted([*neighborhoods(ordinary, regular_budget), *sample(other, other_budget)])]


def render_record_text(record, unrestricted=False):
    text = str(record.get('text') or '')
    if routine_kind(record) != 'pig-result':
        return (text if unrestricted else text[:120]) or '（非文本消息）'
    collection = re.search(r'已收集\s*[:：]\s*(\d+\s*/\s*\d+)', text)
    if collection:
        return f'[例行猪圈查询结果：已收集 {collection[1]}；模板已压缩，非原话]'
    pig = re.search(r'【([^【】]+)】', text)
    repeat = re.search(r'第\s*(\d+)\s*次', text)
    return '[例行猪猪抽取结果：'+(pig[1] if pig else '猪猪')+(f'，第{repeat[1]}次' if repeat else '')+'；模板已压缩，非原话]'


def render_lines(records, days=1, unrestricted=False):
    return '\n'.join(f"[{datetime.fromtimestamp(float(r['time']), CHINA).strftime('%m-%d %H:%M' if days > 1 else '%H:%M')}] {r['name']}：{render_record_text(r, unrestricted)}" for r in records)
