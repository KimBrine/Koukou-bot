"""Bounded dimension-aware arithmetic for mute durations; never evaluates Python code."""
import math
import re
import unicodedata
from dataclasses import dataclass

UNITS = {"毫秒": .001, "ms": .001, "秒": 1, "秒钟": 1, "s": 1, "分": 60, "分钟": 60, "m": 60,
         "小时": 3600, "钟头": 3600, "时": 3600, "h": 3600, "天": 86400, "日": 86400, "d": 86400,
         "周": 604800, "星期": 604800, "w": 604800, "年": 31536000, "世纪": 3153600000}
FUNCTIONS = {"sqrt": math.sqrt, "abs": abs, "floor": math.floor, "ceil": math.ceil,
             "round": lambda x: math.floor(x+.5), "ln": math.log, "log": math.log10,
             "log10": math.log10, "log2": math.log2, "sin": math.sin, "cos": math.cos, "tan": math.tan}
UNIT_RE = "(?:" + "|".join(sorted(UNITS, key=len, reverse=True)) + ")"


def chinese_number(text):
    if re.fullmatch(r"\d+(?:\.\d+)?", text):
        return float(text)
    digits = dict(zip("零〇一二两三四五六七八九", [0, 0, 1, 2, 2, 3, 4, 5, 6, 7, 8, 9]))
    if all(c in digits for c in text):
        return int("".join(str(digits[c]) for c in text))
    if "点" in text:
        left, right = text.split("点", 1)
        return chinese_number(left) + chinese_number("零"+right)/10**len(right)
    total = section = current = 0
    for c in text:
        if c in digits:
            current = digits[c]
            continue
        unit = {"十": 10, "百": 100, "千": 1000, "万": 10000, "亿": 100000000}.get(c)
        if unit is None:
            raise ValueError("数字无法识别")
        if unit >= 10000:
            total += (section + current or 1)*unit
            section = 0
        else:
            section += (current or 1)*unit
        current = 0
    return total + section + current


def normalize(text):
    s = re.sub(r"\s|个", "", unicodedata.normalize("NFKC", text).lower())
    for pattern, unit in [(r"milliseconds?|msecs?", "毫秒"), (r"seconds?|secs?", "秒"), (r"minutes?|mins?", "分钟"),
                           (r"hours?|hrs?", "小时"), (r"days?", "天"), (r"weeks?|wks?", "周")]:
        s = re.sub(pattern, unit, s)
    s = s.replace("**", "^")
    if re.fullmatch(r"\d{1,3}:[0-5]\d:[0-5]\d", s):
        h, m, seconds = map(int, s.split(":")); s = f"{h*3600+m*60+seconds}秒"
    s = re.sub(r"[零〇一二两三四五六七八九十百千万亿点]+", lambda m: str(chinese_number(m[0])), s)
    for pattern, operator in [(r"乘以|乘|×|·", "*"), (r"(?<=[\d)])x(?=[\d(])", "*"),
                              (r"除以|除|÷", "/"), (r"加上|加", "+"), (r"减去|减", "-")]:
        s = re.sub(pattern, operator, s)
    s = re.sub(r"的(\d+(?:\.\d+)?)次方", r"^\1", s).replace("平方", "^2").replace("立方", "^3").replace("阶乘", "!")
    s = re.sub(r"(?:根号|√)(\d+(?:\.\d+)?)", r"sqrt(\1)", s)
    s = re.sub(r"√(?=\()", "sqrt", s).replace("π", "pi").replace("圆周率", "pi")
    s = re.sub(r"(\d+(?:\.\d+)?)半("+UNIT_RE+r")", lambda m: str(float(m[1])+.5)+m[2], s)
    s = re.sub(r"半("+UNIT_RE+r")", r".5\1", s)
    s = re.sub(r"(\d+(?:\.\d+)?)("+UNIT_RE+r")半", lambda m: str(float(m[1])+.5)+m[2], s)
    return re.sub(r"(?<=[天日时头分钟秒周期])(?:又|零)(?=\d)", "+", s)


@dataclass
class Quantity:
    value: float
    dimension: int = 0


class Parser:
    def __init__(self, text):
        token = re.compile(r"\d+(?:\.\d*)?(?:e[+-]?\d+)?|\.\d+|log10|log2|sqrt|floor|ceil|round|abs|sin|cos|tan|log|ln|pi|e|"+UNIT_RE+r"|[()+\-*/^!%]")
        self.tokens, position = [], 0
        while position < len(text):
            match = token.match(text, position)
            if not match:
                raise ValueError("数学式含有不支持或不明确的字符")
            self.tokens.append(match[0]); position = match.end()
            if len(self.tokens) > 120:
                raise ValueError("数学式过于复杂")
        self.index, self.steps, self.saw_unit = 0, 0, False

    def peek(self):
        return self.tokens[self.index] if self.index < len(self.tokens) else ""

    def pop(self):
        token = self.peek(); self.index += 1
        return token

    def checked(self, value):
        self.steps += 1
        if self.steps > 250 or not math.isfinite(value.value):
            raise ValueError("数学式过于复杂或结果非有限数")
        return value

    def atom(self):
        token = self.pop()
        if token == "(":
            value = self.add()
            if self.pop() != ")":
                raise ValueError("括号不配对")
        elif token in FUNCTIONS:
            if self.pop() != "(":
                raise ValueError("函数需要括号")
            arg = self.add()
            if self.pop() != ")" or arg.dimension:
                raise ValueError("函数参数无效")
            value = Quantity(FUNCTIONS[token](arg.value))
        elif token in {"pi", "e"}:
            value = Quantity(math.pi if token == "pi" else math.e)
        elif re.match(r"[\d.]", token):
            value = Quantity(float(token))
        else:
            raise ValueError("数学式缺少数字")
        while self.peek() == "!":
            self.pop()
            if value.dimension or value.value != int(value.value) or not 0 <= value.value <= 170:
                raise ValueError("阶乘参数无效或过大")
            value = Quantity(float(math.factorial(int(value.value))))
        return self.checked(value)

    def power(self):
        value = self.atom()
        if self.peek() == "^":
            self.pop(); right = self.unary()
            if value.dimension or right.dimension or abs(right.value) > 1024:
                raise ValueError("乘方参数无效或过大")
            value = self.checked(Quantity(math.pow(value.value, right.value)))
        return value

    def unary(self):
        if self.peek() in {"+", "-"}:
            sign = self.pop(); value = self.unary()
            return self.checked(Quantity(-value.value if sign == "-" else value.value, value.dimension))
        return self.power()

    def quantity(self):
        value = self.unary()
        if self.peek() in UNITS:
            if value.dimension:
                raise ValueError("单位重复")
            value = Quantity(value.value*UNITS[self.pop()], 1); self.saw_unit = True
        return self.checked(value)

    def multiply(self):
        left = self.quantity()
        while True:
            token = self.peek()
            implicit = token in {"(", "pi", "e"} or token in FUNCTIONS
            if token not in {"*", "/", "%"} and not implicit:
                return left
            if not implicit:
                self.pop()
            right = self.quantity()
            if token == "%" and (left.dimension or right.dimension):
                raise ValueError("时间取余不支持")
            dimension = left.dimension-right.dimension if token == "/" else left.dimension+right.dimension
            if dimension < 0 or dimension > 1:
                raise ValueError("单位运算不成立")
            if token in {"/", "%"} and not right.value:
                raise ValueError("不能除以零")
            result = left.value/right.value if token == "/" else math.fmod(left.value, right.value) if token == "%" else left.value*right.value
            left = self.checked(Quantity(result, dimension))

    def add(self):
        left = self.multiply()
        while self.peek() and self.peek() != ")":
            token = self.peek()
            if token not in {"+", "-"} and not re.match(r"[\d.]", token):
                break
            if token in {"+", "-"}:
                self.pop()
            right = self.multiply()
            if left.dimension != right.dimension:
                raise ValueError("加减两边需要相同单位")
            left = self.checked(Quantity(left.value-right.value if token == "-" else left.value+right.value, left.dimension))
        return left


def parse_duration(phrase):
    if phrase is None:
        return {"seconds": 60, "defaulted": True}
    if not isinstance(phrase, str) or not phrase.strip() or len(phrase) > 240:
        raise ValueError("请明确禁言时长")
    if re.search(r"[~～至到约多来几或]|两三|三四|四五|五六|六七|七八|八九", phrase):
        raise ValueError("时长有歧义")
    if phrase.strip() in {"永久", "永远", "一辈子", "一生"}:
        return {"overLimit": True}
    parser = Parser(normalize(phrase))
    answer = parser.add()
    if parser.index != len(parser.tokens) or not parser.saw_unit or answer.dimension != 1 or answer.value <= 0:
        raise ValueError("需要明确的正数时长和单位")
    if answer.value > 30*86400:
        return {"overLimit": True}
    seconds = max(1, math.ceil(answer.value-1e-9))
    return {"seconds": seconds, "rounded": abs(answer.value-seconds) > 1e-7, "defaulted": False}
