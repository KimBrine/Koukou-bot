# name: 禁漫查询
# desc: 查 JM 本子详情（标题/作者/页数/标签/章节），纯文本发在聊天里
# usage: /py jmv 350234
# admin: true
"""
jmv.py —— 详情查询入口，等价于 /py jm 查 350234

单独留一个文件是为了少打几个字：/py jmv 350234。
真正干活的代码在 jm.py，这里只做转发；两个文件要放在同一个目录。
"""

import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

import jm  # noqa: E402

if __name__ == '__main__':
    sys.exit(jm.main(['查'] + sys.argv[1:]))
