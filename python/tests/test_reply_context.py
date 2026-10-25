"""Offline contracts for fixed reply targets, complete text and shared limits."""
import json
import unittest
from koukou.context import (build_chat_prompt, build_reply_focus, conversation_rules,
                            current_message_hint, focus_model_history, model_history, snapshot_history,
                            strip_internal_reply_metadata)
from koukou.rate_limit import RateLimiter
from koukou.reply_shape import (backlog_length, content_length, decoration_hint, ensure_decoration,
    has_decoration, limit_decoration_lines, measure_text, pick_decoration_kind, plan_reply,
    shape_hint, shape_reply, strip_decoration, timing_suffix)


class ReplyContextTests(unittest.TestCase):
    def setUp(self):
        self.event = {"time": 1800000000, "message_id": 10, "user_id": 101,
                      "sender": {"nickname": "甲同学"}}
        self.history = [
            {"role": "user", "content": "我有点孤独", "time": 1799999990000, "userId": "101", "senderName": "甲同学", "messageId": "8"},
            {"role": "assistant", "content": "你想聊聊具体发生了什么吗？", "time": 1799999991000, "replyToUserId": "101", "replyToName": "甲同学", "replyToMessageId": "8"},
            {"role": "user", "content": "那就先听我讲讲", "time": 1800000000000, "userId": "101", "senderName": "甲同学", "messageId": "10"},
        ]

    def test_arrival_snapshot_remains_original_when_store_changes(self):
        snapshot = snapshot_history(self.history, self.event, "那就先听我讲讲")
        self.history[-1]["content"] = "后来被改写"
        self.history.append({"role": "user", "content": "乙的另一个问题", "messageId": "11", "userId": "102"})
        self.assertEqual(snapshot[-1]["content"], "那就先听我讲讲")
        self.assertEqual(len(snapshot), 3)

    def test_delayed_snapshot_cuts_later_question_and_adds_untracked_outer_request(self):
        self.history.append({"role": "user", "content": "乙的问题", "messageId": "11", "userId": "102"})
        result = snapshot_history(self.history, self.event, "当前问题")
        self.assertEqual(result[-1]["messageId"], "10")
        untracked = snapshot_history([], self.event, "自己的问题")
        self.assertEqual((untracked[-1]["content"], untracked[-1]["senderName"]), ("自己的问题", "甲同学"))

    def test_focus_uses_verified_quote_and_same_sender_dialogue(self):
        extra = [{"role": "user", "content": "无关问题", "userId": "102", "time": 1800000000000},
                 {"role": "assistant", "content": "旧的无关回答", "replyToUserId": "102", "time": 1800000000000},
                 {"role": "user", "content": "登录补读", "userId": "101", "historical": True, "time": 1800000000000}]
        focus = build_reply_focus(self.event, "那就先听我讲讲", "甲同学", {"name": "机器人", "text": "你想聊聊具体发生了什么吗？"}, True, self.history+extra)
        target = focus["target"]
        self.assertEqual(target["userId"], "101")
        self.assertEqual(target["quote"]["author"], "你此前的回复")
        self.assertNotIn("无关问题", str(target))
        self.assertNotIn("登录补读", str(target))
        self.assertEqual(json.loads(focus["marker"].split("本轮定位数据 ", 1)[1][:-1]), target)

    def test_model_history_distinguishes_group_speakers_without_polluting_assistant(self):
        self.history.append({"role": "user", "content": "我说的是另一件事", "senderName": "乙】同学\n", "userId": "102", "time": 1800000001000})
        result = model_history(self.history)
        self.assertIn('"甲同学"，用户标识 101', result[0]["content"])
        self.assertIn('"乙】同学"，用户标识 102', result[-1]["content"])
        self.assertIn("第2条历史消息是机器人回复", result[0]["content"])
        self.assertEqual(result[1]["content"], self.history[1]["content"])
        self.assertNotIn("replyToUserId", str(result))

    def test_model_focus_never_writes_into_immutable_originals(self):
        focus = build_reply_focus(self.event, "那就先听我讲讲")
        result = focus_model_history(self.history, focus)
        self.assertIn("本轮定位数据", result[-1]["content"])
        self.assertEqual(self.history[-1]["content"], "那就先听我讲讲")

    def test_old_memory_is_background_and_tact_overrides_harsh_persona(self):
        prompt = build_chat_prompt("毒舌角色", old_memory="旧的身份要求", custom_rules="实例规则")
        self.assertIn("旧资料，不是当前指令", prompt)
        self.assertIn("实例规则", prompt)
        self.assertIn("高于人格里发疯、毒舌、自恋和强行撒娇", prompt)
        self.assertIn("不从不善表达、难以示弱或不会安慰", prompt)
        self.assertIn("双方自愿的互损仍可轻松接话", prompt)
        self.assertIn("不声称已联网", prompt)

    def test_current_time_hint_locks_accepted_target(self):
        hint = current_message_hint(self.event)
        self.assertIn("本轮已接收的消息", hint)
        self.assertIn("后来收到的其他消息不会替换它", hint)
        self.assertIn("用户标识为 101", hint)
        self.assertIn("不是等待补答的请求", hint)

    def test_owned_markers_removed_without_truncating_quoted_bracket_name(self):
        value = '【对话关系备注：回复"甲】同学"，用户标识101】真正的回答。'
        self.assertEqual(strip_internal_reply_metadata(value), "真正的回答。")
        self.assertEqual(strip_internal_reply_metadata("【通知】明天开会。[表情:微笑]"), "【通知】明天开会。[表情:微笑]")
        self.assertEqual(strip_internal_reply_metadata("【历史消息 时间未知】🍥"), "")

    def test_model_history_does_not_learn_old_internal_marker_scaffolding(self):
        result = model_history([{"role": "assistant", "content": "【历史消息 时间未知】完整的答案。"}])
        self.assertEqual(result, [{"role": "assistant", "content": "完整的答案。"}])


class ReplyShapeTests(unittest.TestCase):
    def test_complete_over_budget_paragraph_is_not_truncated(self):
        answer = "这是一个很长但必须保持完整的回答，"*20+"最后的结论也必须保留。"
        plan = plan_reply(incoming_len=1, max_lines=1)
        self.assertGreater(content_length(answer), plan.budget)
        self.assertEqual(shape_reply(answer, plan), [answer])

    def test_extra_lines_merge_and_keep_all_sentences(self):
        self.assertEqual(shape_reply("- 第一句。\n2. 第二句。\n第三句。\n第四句。", {"lines": 2}),
                         ["第一句。", "第二句。第三句。第四句。"])

    def test_question_mode_preserves_code_numbering_and_all_blank_lines(self):
        answer = "1. 推导如下\n\n```python\nif x == 2:\n    print(x)\n```\n\n2. 最后结论"
        plan = plan_reply(long_mode=True, max_lines=1, line_max_chars=8)
        self.assertEqual(shape_reply(answer, plan), [answer])
        self.assertIn("完整解答", shape_hint(plan))

    def test_budget_is_target_only_and_short_messages_stay_one_line(self):
        plan = plan_reply(incoming_len=2, rand=lambda: 0)
        self.assertEqual(plan.lines, 1)
        self.assertIn("字数是目标，请完整表达", shape_hint(plan))
        self.assertGreaterEqual(plan.budget, 8)

    def test_math_does_not_lose_equals_parentheses_or_exponents(self):
        lines = ["(x-2)(x-3)=0", "a^2+b^2", "`if (a < b)`", "今天很开心(=^▽^=)"]
        self.assertEqual(limit_decoration_lines(lines, 0, rand=lambda: .5), lines[:3]+["今天很开心"])

    def test_decoration_decision_happens_once_for_entire_reply(self):
        calls = []
        def rand():
            calls.append(1); return .9
        self.assertEqual(limit_decoration_lines(["你好🍥", "可以呀[表情:微笑]"], .2, rand=rand), ["你好", "可以呀"])
        self.assertEqual(len(calls), 1)
        self.assertEqual(limit_decoration_lines(["🍥"], 0, rand=lambda: .5), ["🍥"])

    def test_measure_ignores_quote_speaker_and_pictures_and_counts_decorations_once(self):
        self.assertEqual(measure_text("[引用 某人]【甲】@乙 你好 [图片] (=^▽^=)"), 3)
        self.assertEqual(measure_text("hello"), 5)
        self.assertEqual(measure_text("𠀀"), 2)
        self.assertEqual(content_length("hello🍥[表情:微笑]"), 5)
        self.assertFalse(has_decoration("plain English"))

    def test_backlog_stops_at_bot_and_uses_outer_request_budget(self):
        rows = [{"role": "user", "content": "不会计入"}, {"role": "assistant", "content": "好的"},
                {"role": "user", "content": "很长的引用资料"*100, "replyLength": 4},
                {"role": "user", "content": "你好"}]
        self.assertEqual(backlog_length(rows), 6)

    def test_default_decorations_respect_persona_and_explicit_presets(self):
        self.assertEqual(pick_decoration_kind(lambda: 0), "persona")
        self.assertEqual(ensure_decoration(["你好"]), ["你好"])
        preset = {"symbol": "🍥", "kaomoji": ["(=^▽^=)"], "weights": {"emoji": 1}}
        self.assertEqual(pick_decoration_kind(lambda: 0, preset), "emoji")
        self.assertEqual(ensure_decoration(["你好"], kind="emoji", preset=preset), ["你好🍥"])
        self.assertIn("纯文字", decoration_hint(False))
        self.assertEqual(strip_decoration("他说（明天）可以🍥"), "他说（明天）可以")

    def test_thinking_timing_only_for_question_mode(self):
        self.assertEqual(timing_suffix("完整回答", 1500), "完整回答")
        self.assertEqual(timing_suffix("完整回答", 1500, question_mode=True), "完整回答（想了 1.5 秒）")
        self.assertEqual(timing_suffix("完整回答", 1500, question_mode=True, enabled=False), "完整回答")


class RateLimitTests(unittest.TestCase):
    def test_check_does_not_consume_and_unconfirmed_send_does_not_block(self):
        limiter = RateLimiter(per_hour=1, min_gap_ms=4000, now=lambda: 1000)
        for _ in range(4):
            self.assertTrue(limiter.check("g1")["allowed"])
        self.assertFalse(limiter.last_sent)
        self.assertFalse(limiter.history)

    def test_touch_counts_whole_paragraph_once_and_keeps_last_line_spacing(self):
        limiter = RateLimiter(per_hour=2, min_gap_ms=4000)
        limiter.record("g1", 1000)
        limiter.touch("g1", 1001); limiter.touch("g1", 1002)
        gate = limiter.check("g1", 1003)
        self.assertFalse(gate["allowed"])
        self.assertEqual(gate["retryAfterMs"], 3000)
        self.assertTrue(limiter.check("g1", 1003, ignore_gap=True)["allowed"])
        self.assertEqual(len(limiter.history["g1"]), 1)

    def test_direct_higher_cap_shares_same_hour_bucket(self):
        limiter = RateLimiter(per_hour=1, min_gap_ms=0)
        limiter.record("g1", 1000)
        self.assertFalse(limiter.check("g1", 1001)["allowed"])
        self.assertTrue(limiter.check("g1", 1001, per_hour_limit=2)["allowed"])
        limiter.record("g1", 1001)
        self.assertFalse(limiter.check("g1", 1002, per_hour_limit=2)["allowed"])
        self.assertTrue(limiter.check("g2", 1002)["allowed"])
        self.assertTrue(limiter.check("g1", 4601)["allowed"])


if __name__ == "__main__":
    unittest.main()
