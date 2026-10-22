# name: 计算器
# desc: 计算数学表达式，支持 + - * / ** % // 与常用数学函数
# usage: /py calc 1+2*3 或 /py calc sqrt(2)
import ast
import math
import sys

ALLOWED = {k: getattr(math, k) for k in dir(math) if not k.startswith('_')}
ALLOWED.update({'abs': abs, 'round': round, 'min': min, 'max': max, 'sum': sum, 'len': len})
OPS = {
    ast.Add: lambda a, b: a + b, ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b, ast.Div: lambda a, b: a / b,
    ast.Pow: lambda a, b: a ** b, ast.Mod: lambda a, b: a % b,
    ast.FloorDiv: lambda a, b: a // b,
}

def ev(node):
    if isinstance(node, ast.Expression):
        return ev(node.body)
    if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
        return node.value
    if isinstance(node, ast.BinOp):
        fn = OPS.get(type(node.op))
        if not fn:
            raise ValueError('不支持的运算符')
        return fn(ev(node.left), ev(node.right))
    if isinstance(node, ast.UnaryOp):
        value = ev(node.operand)
        return -value if isinstance(node.op, ast.USub) else value
    if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in ALLOWED and not node.keywords:
        return ALLOWED[node.func.id](*[ev(a) for a in node.args])
    raise ValueError('不支持的表达式')

expr = ' '.join(sys.argv[1:]).strip()
if not expr:
    print('用法：/py calc 1+2*3')
    sys.exit(1)
print(ev(ast.parse(expr, mode='eval')))
