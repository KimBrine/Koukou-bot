"""Native reply planning and decoration control; length is never a send knife."""
from dataclasses import asdict, dataclass
import math
import random
import re
import unicodedata
from .context import TABLES


KAOMOJI_SYMBOLS = '=^▽ωﾉ≧≦ΣД゜∀´`ˊˋ・﹏๑٩۶◕‿⌒ノヽゞヾミ＞＜＾°◡ᴗಥஇ｡•︿﹃﹄⊙△▼▼∀⌒'
_symbols = re.escape(KAOMOJI_SYMBOLS)
_emoji_ranges = "".join(re.escape(chr(lo)) + ("-" + re.escape(chr(hi)) if hi != lo else "")
                       for lo, hi in TABLES["emojiRanges"])
_pictographic = "[" + _emoji_ranges + "]"
_emoji = "[" + _emoji_ranges + "\ufe0f\u200d]"
_combining = r"[\u0300-\u036f\u20d0-\u20ff]"
_paren = rf"[（(][^（）()]{{0,20}}(?:[{_symbols}]|{_combining})[^（）()]{{0,20}}[）)]"
_bare = rf"[{_symbols}]+"
_face = r"\[表情[:：]\s*[^\[\]]{1,12}\]"
_tic = r"(?:awa|qwq|QAQ|TAT|XD|Orz|orz)"
DECORATION_RE = re.compile(rf"(?:{_face}|{_paren}|{_bare}|{_emoji}|{_combining}|{_tic})")


def _text(value):
    return "" if value is None else str(value)


def _length(text):
    # The source uses JS String.length, including supplementary CJK as two units.
    return len(text.encode("utf-16-le", errors="surrogatepass"))//2


def _round(value):
    return math.floor(value+.5)


def has_decoration(text):
    # Source hasDecoration intentionally recognizes fewer textual tics than its
    # strip/measure pattern. Preserve that distinction for existing personas.
    return bool(re.search(rf"(?:{_face}|{_paren}|{_bare}|{_pictographic}|{_combining}|awa|qwq|QAQ|XD)", _text(text)))


def strip_decoration(text):
    value = DECORATION_RE.sub("", _text(text))
    value = re.sub(r"[（(]\s*[)）]", "", value)
    value = re.sub(r"^[\s，。！？～…、·]*[)）]+", "", value)
    value = re.sub(r"[（(]+[\s，。！？～…、·]*$", "", value)
    value = re.sub(r"[（(]+(?=\s*[)）])", "", value)
    value = re.sub(r"[)）]+(?=[（(])", "", value)
    value = re.sub(r"\s{2,}", " ", value)
    value = re.sub(r"\s+([，。！？～…、）)])", r"\1", value)
    value = re.sub(r"^[\s，。！？～…、·]+", "", value)
    return re.sub(r"[\s，、·]+$", "", value).strip()


def looks_like_code_or_math(text):
    return any(re.search(pattern, _text(text)) for pattern in [
        r"`[^`]+`", r"[A-Za-z0-9}]\s*[=<>]\s*[-A-Za-z0-9(\[]",
        r"[A-Za-z0-9)(]\s*[\^+*/]\s*[A-Za-z0-9(]", r"[√∑∫≤≥≠≈π]",
    ]) or bool(re.search(r"[A-Za-z0-9]\s*-\s*[A-Za-z0-9(]", _text(text)) and
               re.search(r"[=()\[\]^+*/]", _text(text)))


def _has_body(text):
    return any(not char.isspace() and not unicodedata.category(char).startswith("P") for char in text)


def limit_decoration_lines(lines, keep_rate=.2, *, rand=random.random):
    values = [_text(line).strip() for line in (lines if isinstance(lines, (list, tuple)) else [lines])]
    values = [line for line in values if line]
    if not values or rand() < keep_rate:
        return values
    output = []
    for line in values:
        stripped = strip_decoration(line) if has_decoration(line) and not looks_like_code_or_math(line) else line
        output.append(stripped if _has_body(stripped) else line)
    return output


def limit_decoration(text, keep_rate=.2, *, rand=random.random):
    value = _text(text).strip()
    if not value or not has_decoration(value) or rand() < keep_rate:
        return value
    stripped = strip_decoration(value)
    return stripped if _has_body(stripped) else value


def measure_text(text):
    value = DECORATION_RE.sub("饰", _text(text)).replace("[图片]", "")
    value = re.sub(r"^\[引用[^\]]{0,300}\]\s*", "", value)
    value = re.sub(r"^【[^】]{0,24}】", "", value)
    value = re.sub(r"^@[^\s，,。！？!?]{0,24}\s*", "", value)
    return _length(re.sub(r"\s+", "", value))


def content_length(text):
    return _length(re.sub(r"\s", "", DECORATION_RE.sub("", _text(text))))


def backlog_length(history, cap=240):
    total = 0
    for item in reversed(history if isinstance(history, list) else []):
        if not isinstance(item, dict) or item.get("role") != "user":
            break
        length = item.get("replyLength")
        total += length if isinstance(length, (float, int)) and not isinstance(length, bool) and math.isfinite(length) and length >= 0 else measure_text(item.get("content"))
        if total >= cap:
            return cap
    return total


def pick_line_count(target_len, *, max_lines=3, line_max_chars=40, rand=random.random):
    if max_lines <= 1 or target_len < 16:
        return 1
    p2, p3 = ((.13, .02) if target_len <= 20 else (.32, .09) if target_len <= line_max_chars else
              (.5, .32) if target_len <= line_max_chars*2 else (.24, .72))
    value = rand()
    lines = 3 if value < p3 else 2 if value < p3+p2 else 1
    return min(lines, 2 if target_len < 30 else 3, max_lines)


@dataclass(frozen=True)
class ReplyPlan:
    target_len: int
    lines: int
    budget: int
    per_line_cap: int
    line_max_chars: int
    long_mode: bool = False

    def as_dict(self):
        return asdict(self)


def plan_reply(*, incoming_len=0, backlog_len=0, max_lines=3, line_max_chars=40,
               match_enabled=True, long_mode=False, min_budget=0, backlog_weight=.35, rand=random.random):
    max_lines = max(1, int(max_lines))
    line_max_chars = max(8, int(line_max_chars))
    target = max(0, _round(incoming_len+backlog_len*backlog_weight))
    if long_mode:
        return ReplyPlan(target, max_lines, max_lines*line_max_chars, line_max_chars, line_max_chars, True)
    lines = pick_line_count(target, max_lines=max_lines, line_max_chars=line_max_chars, rand=rand) if match_enabled else 1
    if min_budget > 0:
        budget = min(lines*line_max_chars, max(min_budget, _round(target*1.15)+8))
        return ReplyPlan(target, lines, budget, line_max_chars, line_max_chars)
    budget = max(8, min(lines*line_max_chars, _round(target*1.15)+8))
    per_line_cap = max(8, min(line_max_chars, math.ceil(budget/lines)+6))
    return ReplyPlan(target, lines, budget, per_line_cap, line_max_chars)


def _get(plan, name, default=None):
    if isinstance(plan, dict):
        camel = name.split("_")[0] + "".join(part.title() for part in name.split("_")[1:])
        return plan.get(name, plan.get(camel, default))
    return getattr(plan, name, default)


def _clean_line(line):
    value = re.sub(r"^\s*[-*•·—]+\s*", "", _text(line))
    value = re.sub(r"^\s*[0-9]+\s*[.、)）]\s*", "", value)
    return re.sub(r"^\s*第\s*[0-9]+\s*[条行句]\s*[:：]?\s*", "", value).strip()


def split_one_line(text, max_lines, line_cap):
    value = _text(text).strip()
    if max_lines <= 1 or not value or _length(value) <= line_cap:
        return [value]
    parts = [part.strip() for part in re.split(r"(?<=[。！？!?…～])", value) if part.strip()]
    if len(parts) < 2:
        parts = [part.strip() for part in re.split(r"[，,、]", value) if part.strip()]
    if len(parts) < 2:
        return [value]
    while len(parts) > max_lines:
        last = parts.pop()
        parts[-1] += ("" if re.search(r"[。！？!?…～，,、]$", parts[-1]) else "，") + last
    return parts


def shape_reply(raw, plan=None, *, long_mode=None):
    value = _text(raw).strip()
    if long_mode is True or long_mode is None and _get(plan, "long_mode", False):
        # Keep code, numbering, blank lines and full derivations intact in /Q.
        return [value] if value else []
    maximum = max(1, _get(plan, "lines", 1))
    cap = max(8, _get(plan, "per_line_cap", _get(plan, "line_max_chars", 40)))
    lines = [_clean_line(line) for line in re.split(r"\r\n?|\n", _text(raw))]
    lines = [line for line in lines if line]
    if len(lines) == 1 and maximum > 1:
        lines = split_one_line(lines[0], maximum, cap)
    if len(lines) > maximum:
        lines = lines[:maximum-1] + ["".join(lines[maximum-1:])]
    return lines


def pick_decoration_kind(rand=random.random, preset=None):
    if not preset:
        return "persona"
    weights = preset.get("weights") or {}
    value = rand()*sum(weights.get(kind, 0) for kind in ["emoji", "kaomoji", "both"])
    for kind in ["emoji", "kaomoji", "both"]:
        value -= weights.get(kind, 0)
        if value < 0:
            return kind
    return "persona"


def decoration_hint(allowed, kind="persona", preset=None):
    if not allowed:
        return "\n\n【本条回复的装饰】只使用纯文字，不加颜文字、emoji 或 QQ 表情；语气仍以当前人格为准。"
    if kind == "persona" or not preset:
        return "\n\n【本条回复的装饰】可选择一个符合当前人格与语境的表情；没有合适的就不加，不固定偏爱某个符号。"
    voice, symbol = preset.get("voiceHint", ""), preset.get("symbol", "")
    kaomoji = "、".join(preset.get("kaomoji", [])[:5])
    if kind == "kaomoji":
        return f"\n\n【本条回复的装饰】{voice}这次可以用一个颜文字：{kaomoji}。"
    if kind == "both":
        return f"\n\n【本条回复的装饰】{voice}这次可用 {symbol} 配一个颜文字，别堆。"
    return f"\n\n【本条回复的装饰】{voice}这次可以带一个 {symbol}，放句末。"


def ensure_decoration(lines, source_text="", *, kind="persona", rand=random.random, preset=None):
    if not preset or kind == "persona":
        return lines
    values = [line for line in lines if line]
    if not values or DECORATION_RE.search("".join(values)):
        return lines
    pool, symbol = preset.get("kaomoji", []), preset.get("symbol", "")
    kao = pool[min(len(pool)-1, math.floor(rand()*len(pool)))] if pool else ""
    decoration = kao if kind == "kaomoji" else symbol+kao if kind == "both" else symbol
    if not decoration:
        return lines
    values[-1] += decoration
    return values


def shape_hint(plan):
    target, lines, budget, maximum = (_get(plan, name) for name in ["target_len", "lines", "budget", "line_max_chars"])
    if _get(plan, "long_mode", False):
        return "\n\n【本次解题要求】完整解答本题，保留必要的推导、步骤、公式和代码，不按日常篇幅目标截断。"
    per_line = max(4, min(maximum, _round(budget/max(1, lines))))
    if lines <= 1:
        lo = max(3, _round(budget*.6))
        return f"\n\n【本次回复的形态要求（系统自动生成，绝不要提及它）】对方这条消息大约 {target} 字。请你也用差不多的长度回：一行写完，{lo}~{budget} 字（不超过 {maximum} 字），像微信/QQ 里随口接一句话那样自然。字数是目标，请完整表达，不要用省略号代替没说完的后文。"
    lo = max(4, _round((budget/lines)*.7))
    return f"\n\n【本次回复的形态要求（系统自动生成，绝不要提及它）】对方这次说的内容大约 {target} 字，你的回复长度要和他相当。请分成 {lines} 行写（用换行分隔），每行 {lo}~{per_line} 字、整体 {lo*lines}~{budget} 字——这是目标长度，请写满一些，不要只丢一句很短的话。系统会把你每一行单独作为一条消息发出去，所以每一行都要是能独立成立、读起来自然的一句话，不要编号、不要列表符号、不要把某一行写成上一行的续句。字数是目标，请完整表达，不要用省略号代替没说完的后文。"


def typing_delay_seconds(min_ms=600, max_ms=2500, *, rand=random.random):
    return math.floor(min_ms+rand()*max(0, max_ms-min_ms))/1000


def split_message(text, maximum=1800):
    """Respect QQ packet size without dropping, ellipsizing or changing any text."""
    if not isinstance(maximum,int) or maximum<2:raise ValueError('消息分段大小至少为2')
    rest,parts = _text(text),[]
    while _length(rest)>maximum:
        units,cut=0,0
        for i,char in enumerate(rest):
            size=_length(char)
            if units+size>maximum:break
            units+=size;cut=i+1
        preferred=max(rest.rfind('\n',0,cut+1),rest.rfind('。',0,cut+1),rest.rfind('！',0,cut+1))
        if preferred>=cut//2:cut=preferred+1
        marker=rest.rfind('[表情',0,cut)
        if marker>0 and ']' not in rest[marker:cut]:cut=marker
        parts.append(rest[:cut]);rest=rest[cut:]
    if rest:parts.append(rest)
    return parts


def timing_suffix(text, elapsed_ms, *, question_mode=False, enabled=True):
    if question_mode and enabled and elapsed_ms > 0 and _text(text):
        # Source JS toFixed(1) uses ties toward positive at the decimal step.
        return _text(text)+f"（想了 {_round(elapsed_ms/100)/10:.1f} 秒）"
    return _text(text)
