# name: 文本统计
# desc: 统计字数、行数、空格分段
# usage: /py textstats 一段文字
import sys
text = ' '.join(sys.argv[1:])
if not text.strip():
    print('用法：/py textstats 一段文字')
    sys.exit(1)
print('字符数：%d' % len(text))
print('非空白字符：%d' % len(''.join(text.split())))
print('分段：%d' % len(text.split()))
