# name: 计算器
# desc: 计算数学表达式，支持 + - * / ** % // 与常用数学函数；全角数字、全角括号和 ×÷＋－，加/减/乘/除以/平方 中文写法都能识别
# usage: /py calc 1+2*3 或 /py calc sqrt(2) 或 /py calc （１＋２）×３ 或 /py calc 10除以4
import ast
import math
import sys
import unicodedata

ALLOWED = {k: getattr(math, k) for k in dir(math) if not k.startswith('_')}
ALLOWED.update({'abs': abs, 'round': round, 'min': min, 'max': max, 'sum': sum, 'len': len})
OPS = {
    ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b, ast.Div: lambda a, b: a / b,
    ast.Pow: lambda a, b: a ** b, ast.Mod: lambda a, b: a % b,
    ast.FloorDiv: lambda a, b: a // b,
}

# 全角字符由 NFKC 处理（０-９、＋－（）、％、字母等），下面补 NFKC 不认的数学符号
SYMBOLS = {
    '×': '*', '✕': '*', '＊': '*', '·': '*',
    '÷': '/', '／': '/',
    '−': '-', '–': '-', '—': '-', '﹣': '-',
    '√': 'sqrt', 'π': 'pi', 'Π': 'pi',
    '％': '%',
    '²': '**2', '³': '**3',
    '，': ',', '、': ',',
    '　': ' ',
}
# 中文运算符按"长的先换"排列，避免「除以」被拆成「除」+「以」
WORDS = [
    ('的平方', '**2'), ('平方', '**2'),
    ('除以', '/'), ('乘以', '*'),
    ('加', '+'), ('减', '-'), ('乘', '*'), ('除', '/'),
]
MAX_LEN = 500
MAX_EXPONENT = 1000


def normalize(text):
    # NFKC 会把上标压成普通数字，须先保留幂语义。
    s = unicodedata.normalize('NFKC', str(text).replace('²', '**2').replace('³', '**3'))
    for key, value in SYMBOLS.items():
        s = s.replace(key, value)
    for key, value in WORDS:
        s = s.replace(key, value)
    return s.strip()


def ev(node):
    if isinstance(node, ast.Expression):
        return ev(node.body)
    if isinstance(node, ast.Constant) and type(node.value) in (int, float):
        return node.value
    if isinstance(node, ast.Name) and type(ALLOWED.get(node.id)) in (int, float):
        return ALLOWED[node.id]
    if isinstance(node, ast.BinOp):
        fn = OPS.get(type(node.op))
        if not fn:
            raise ValueError('不支持的运算符')
        left = ev(node.left)
        right = ev(node.right)
        # 幂要先算指数再判，否则 9**9**9 会先算 9**387420489 把进程挂死
        if isinstance(node.op, ast.Pow):
            if not isinstance(right, (int, float)) or abs(right) > MAX_EXPONENT:
                raise ValueError('指数太大，请控制在 %d 以内' % MAX_EXPONENT)
            if abs(left) > 10 ** 6 and abs(right) > 100:
                raise ValueError('这个幂运算太大，换个写法吧')
        value = fn(left, right)
        if isinstance(value, int) and value.bit_length() > 20000:
            raise ValueError('结果太大（超过 6000 位）')
        return value
    if isinstance(node, ast.UnaryOp):
        if not isinstance(node.op, (ast.USub, ast.UAdd)):
            raise ValueError('不支持的运算符')
        value = ev(node.operand)
        return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ALLOWED and not node.keywords:
        return ALLOWED[node.func.id](*[ev(a) for a in node.args])
    raise ValueError('不支持的表达式')


def fmt(value):
    if isinstance(value, float):
        if value.is_integer():
            return str(int(value))
        return str(round(value, 10))
    return str(value)


expr = ' '.join(sys.argv[1:]).strip()
if not expr:
    print('用法：/py calc 1+2*3（全角、×÷、加/减/乘/除以 也可以）')
    sys.exit(1)
expr = normalize(expr)
if len(expr) > MAX_LEN:
    print('表达式太长（上限 %d 个字符）' % MAX_LEN)
    sys.exit(1)
try:
    print(fmt(ev(ast.parse(expr, mode='eval'))))
except ZeroDivisionError:
    print('不能除以 0')
    sys.exit(1)
except (ValueError, SyntaxError, TypeError, OverflowError) as err:
    print('表达式看不懂：%s' % (err or '格式不对'))
    sys.exit(1)
