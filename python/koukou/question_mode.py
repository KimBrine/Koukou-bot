"""Single-answer teacher mode, detected only in the current outer message."""
import re

MARKER = re.compile(r'(^|[\s，。！？；：、（(【\u2e80-\u2fff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\U00020000-\U000323af])/Q(?![A-Za-z_])',re.I)
HINT = '\n【本轮/Q解题模式】仅本轮作为认真耐心的小帮手和小老师，保留当前人格名字与亲切语气，以准确、现实和教学质量优先，不用接梗代替解答。/Q只是模式标记，不是题目内容。完整提供必要的步骤、推导、公式或代码，并核对计算和边界条件。资料不足明确说明，不编题干、结果或来源；不给出隐藏思维链，仅解释用户理解解法所需的依据与检查。后续未带/Q的消息恢复普通聊天。'


def has_question_marker(text):
    return bool(MARKER.search(str(text or '')))


def is_question_mode(text,*,private=False,at_bot=False):
    return (private or at_bot) and has_question_marker(text)
