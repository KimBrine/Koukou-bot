import asyncio
from datetime import datetime
import json
from pathlib import Path
import tempfile
import time
import unittest
from koukou.config import Config
from koukou.memory import Memory
from koukou.messages import Timeline, parse_message
from koukou.models import ModelError
from koukou.summary_basics import SummaryProgress, analyze_text, summary_stats, parse_summary_format, content_profile
from koukou.summary_history import SummaryHistory, merge_records
from koukou.summary_quality import generate_checked, inspect_quality
from koukou.summary_service import SummaryService


async def no_pause(seconds): pass


def message(id, at, seq=None, author=11):
    return {'message_id': id, 'time': at, 'message_seq': seq if seq is not None else id, 'real_seq': id,
            'user_id': author, 'sender': {'nickname': '甲'}, 'message': '讨论内容'+str(id)}


class HistoryTests(unittest.IsolatedAsyncioTestCase):
    async def test_start_boundary_requires_second_stable_scan(self):
        calls = []
        class Protocol:
            self_id = '10'; timeline = Timeline()
            async def api(self, action, params, **options):
                calls.append(params)
                return {'messages': [message(3, 120), message(2, 110), message(1, 80)]}
        result = await SummaryHistory(Protocol(), pause=no_pause).backfill(100, 100, 130)
        self.assertTrue(result['complete']); self.assertEqual(result['rounds'], 2)
        self.assertEqual(len(calls), 4)

    async def test_visible_boundary_and_api_failure_never_claim_complete(self):
        class Protocol:
            self_id = '10'; timeline = Timeline()
            async def api(self, action, params, **options):
                return {'messages': [message(3, 120), message(2, 110)]}
        result = await SummaryHistory(Protocol(), pause=no_pause).backfill(100, 100, 130)
        self.assertFalse(result['complete']); self.assertEqual(result['reason'], 'start_not_reached')
        self.assertLessEqual(result['rounds'], 3)
        async def failed(*args, **kwargs): raise RuntimeError('history unsupported')
        protocol = Protocol(); protocol.api = failed
        result = await SummaryHistory(protocol, pause=no_pause).backfill(100, 100, 130)
        self.assertFalse(result['complete']); self.assertEqual(result['reason'], 'api_failed')

    async def test_current_page_read_timeout_recovers_without_duplication(self):
        attempts = [0]
        class Protocol:
            self_id = '10'; timeline = Timeline()
            async def api(self, action, params, **options):
                attempts[0] += 1
                if attempts[0] == 2: raise TimeoutError('timeout')
                return {'messages': [message(2, 110), message(1, 80)]}
        result = await SummaryHistory(Protocol(), pause=no_pause).backfill(100, 100, 130)
        self.assertTrue(result['complete']); self.assertEqual(len(result['records']), 2)

    async def test_deleted_cursor_uses_only_actual_neighbor_from_same_page(self):
        seen = []
        class Protocol:
            self_id = '10'; timeline = Timeline()
            async def api(self, action, params, **options):
                seq = params.get('message_seq'); seen.append(seq)
                if seq == 8: raise RuntimeError('message not found')
                if seq == 9: return {'messages': [message(9, 115, 9), message(7, 80, 7)]}
                return {'messages': [message(10, 120, 10), message(9, 115, 9), message(8, 110, 8)]}
        result = await SummaryHistory(Protocol(), pause=no_pause).backfill(100, 100, 130)
        self.assertTrue(result['complete']); self.assertIn(8, seen); self.assertIn(9, seen)

    async def test_merge_exclusive_end_and_preserve_reply_metadata(self):
        history = [{'id': '1', 'time': 100, 'text': '旧', 'replyId': 'q'}, {'id': '2', 'time': 130, 'text': '截止'}]
        captured = [{'id': '1', 'time': 100, 'text': '新'}]
        self.assertEqual(merge_records(history, captured, 100, 130), [{'id': '1', 'time': 100, 'text': '新', 'replyId': 'q'}])


class ReportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.config = Config(self.temp.name, environ={})
        self.records = [{'id': '1', 'time': time.time()-5, 'userId': '11', 'name': '甲', 'text': '明天测试记得准备演示'}, {'id': '2', 'time': time.time()-4, 'userId': '12', 'name': '乙', 'text': '我会带上演示设备'}]
        self.text = '💬 热门话题\n1. 演示准备\n参与者: 甲、乙\n甲提醒明天测试需要准备演示，乙表示会带设备。\n\n🏆 群友称号\n• 甲 - 提醒员 (INTP)\n发言1条，提醒准备。\n\n• 乙 - 准备员 (INTP)\n发言1条，提供设备。\n\n💬 群圣经\n1. "明天测试记得准备演示" —— 甲\n提醒同伴准备工作。'
        self.sent, self.calls = [], []
        outer = self
        class Protocol:
            self_id = '10'; timeline = Timeline()
            def status(self): return {'online': True}
            async def api(self, action, params, **kwargs): outer.sent.append((action, params)); return {'message_id': len(outer.sent)}
            async def send(self, key, text): outer.sent.append(('text', text)); return {'message_id': len(outer.sent)}
        class Model:
            async def chat(self, *args, **kwargs): outer.calls.append(kwargs); return outer.text
        self.protocol = Protocol()
        self.service = SummaryService(self.config, self.protocol, Model(), Memory(self.config.data_dir), {}, pause=no_pause)
        async def backfill(*args, **kwargs): return {'complete': True, 'records': outer.records}
        self.service.history.backfill = backfill

    async def asyncTearDown(self):
        await self.service.close(); self.temp.cleanup()

    async def test_success_only_after_forward_receipt_and_ack_is_job_specific(self):
        result = self.service.trigger([100]); self.assertEqual(self.service.progress.get(100)['status'], 'generating')
        self.assertEqual(self.service.trigger([100])['busy'], [100])
        await self.service.wait()
        progress = self.service.progress.get(100)
        self.assertEqual(progress['status'], 'success'); self.assertEqual(self.sent[0][0], 'send_group_forward_msg')
        self.assertTrue(self.calls[0]['unlimited'])
        self.assertFalse(self.service.progress.acknowledge(100, 'old'))
        self.assertTrue(self.service.progress.acknowledge(100, progress['jobId']))

    async def test_history_incomplete_does_not_call_model_or_publish(self):
        async def incomplete(*args, **kwargs): return {'complete': False, 'records': self.records}
        self.service.history.backfill = incomplete
        self.service.trigger([100]); await self.service.wait()
        self.assertEqual(self.service.progress.get(100)['status'], 'failed')
        self.assertFalse(self.calls); self.assertFalse(self.sent)

    async def test_uncertain_send_blocks_blind_new_generation(self):
        async def unknown(*args, **kwargs): self.sent.append('unknown'); return {}
        self.protocol.api = unknown
        self.service.trigger([100]); await self.service.wait()
        self.assertEqual(self.service.progress.get(100)['status'], 'failed')
        count = len(self.calls)
        self.service.trigger([100]); await self.service.wait()
        self.assertEqual(len(self.sent), 1); self.assertEqual(len(self.calls), count)

    async def test_dry_run_never_sends_and_failure_has_no_false_success(self):
        self.service.trigger([100], dry_run=True); await self.service.wait()
        self.assertEqual(self.service.progress.get(100)['status'], 'success'); self.assertFalse(self.sent)
        self.text = '缺少必要小节'
        self.service.trigger([100]); await self.service.wait()
        self.assertEqual(self.service.progress.get(100)['status'], 'failed'); self.assertFalse(self.sent)

    async def test_content_refusal_statistics_only_without_reposting_rejected_input(self):
        outer = self
        class Refused:
            async def chat(self, *args, **kwargs): outer.calls.append('refused'); raise ModelError('content_filter', 400)
        self.service.model = Refused()
        self.service.trigger([100]); await self.service.wait()
        self.assertEqual(self.calls, ['refused'])
        self.assertEqual(self.service.progress.get(100)['resultKind'], 'statistics')
        self.assertIn('统计版', self.sent[0][1]['messages'][0]['data']['content'][0]['data']['text'])

    async def test_solo_bot_topic_and_invented_quote_are_rejected(self):
        records = [{'userId': str(i%3+11), 'name': ['甲', '乙', '丙'][i%3], 'text': '实际多人讨论内容'+str(i), 'time': i+1} for i in range(60)]
        text = self.text.replace('参与者: 甲、乙', '参与者: 甲').replace('明天测试记得准备演示', '这句并没说过')
        quality = inspect_quality(text, records, summary_stats(records))
        self.assertTrue(any('单人' in issue for issue in quality['fatalIssues']))
        self.assertTrue(any('原话' in issue for issue in quality['fatalIssues']))

    async def test_interrupted_progress_is_explicit_on_restart(self):
        job = self.service.progress.start(100)
        restored = SummaryProgress(self.service.progress.file)
        self.assertEqual(restored.get(100)['status'], 'failed')
        self.assertEqual(restored.get(100)['stage'], 'interrupted')


if __name__ == '__main__': unittest.main()
