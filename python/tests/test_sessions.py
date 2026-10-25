import asyncio
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from koukou.admin import Admin
from koukou.archive import MemoryArchive, stamp
from koukou.backup import Backup
from koukou.config import Config
from koukou.greetings import GreetingLibrary
from koukou.memory import Memory, LongMemory
from koukou.plugins import PluginManager
from koukou.sessions import Sessions, recover_session, normalize_patch
from koukou.state import read_json, write_json, write_text


class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = Config(self.root, environ={})
        self.memory, self.long, self.settings = Memory(self.config.data_dir), LongMemory(self.config.data_dir), {}
        self.sessions = Sessions(self.config, self.memory, self.long, self.settings)
        for name in ['甲', '乙']:
            self.sessions.save(name, name+'的人格', create=True)

    def tearDown(self):
        self.temp.cleanup()

    def remember(self, text):
        self.memory.push('g100', 'user', text)
        self.long.edit('g100', text+'摘要', paused=True)

    def test_global_persona_roundtrip_and_same_name_keeps_memory(self):
        self.sessions.activate('甲'); self.remember('甲记忆')
        self.sessions.activate('乙')
        self.assertEqual(self.memory.get('g100'), [])
        self.assertEqual(self.long.record('g100')['summary'], '')
        self.remember('乙记忆')
        self.sessions.activate('甲')
        self.assertEqual(self.memory.get('g100')[0]['content'], '甲记忆')
        self.assertEqual(self.long.record('g100')['summary'], '甲记忆摘要')
        self.sessions.save('甲', '更新后的甲人格')
        self.sessions.activate('甲')
        self.assertEqual(self.memory.get('g100')[0]['content'], '甲记忆')
        self.sessions.activate('乙')
        self.assertEqual(self.memory.get('g100')[0]['content'], '乙记忆')

    def test_conversation_switch_clears_only_target_and_file_edits_establish_new_boundary(self):
        self.remember('旧记忆'); self.memory.push('p200', 'user', '别的会话')
        result = self.sessions.set('g100', {'persona': '甲'})
        self.assertTrue(result['memoryReset']['backedUp'])
        self.assertEqual(self.memory.get('g100'), [])
        self.assertEqual(self.memory.get('p200')[0]['content'], '别的会话')
        self.remember('甲会话')
        self.sessions.save('甲', '改变正文')
        self.sessions.prepare('g100')
        self.assertEqual(self.memory.get('g100'), [])
        self.assertEqual(self.long.record('g100')['summary'], '')

    def test_failed_switch_restores_files_and_runtime(self):
        self.sessions.activate('甲'); self.remember('不可丢失')
        before = self.memory.snapshot()
        with patch.object(self.config, 'save', side_effect=OSError('模拟写入失败')):
            with self.assertRaises(OSError):
                self.sessions.activate('乙')
        self.assertEqual(self.memory.snapshot(), before)
        self.assertEqual(Memory(self.config.data_dir).snapshot(), before)
        self.assertEqual(self.config.get('ACTIVE_PERSONA'), '甲')
        self.assertFalse(self.sessions.journal.exists())

    def test_startup_recovery_and_invalid_journal_do_not_follow_paths(self):
        self.remember('崩溃前')
        text = self.memory.file.read_text(encoding='utf-8')
        write_json(self.sessions.journal, {'version': 1, 'phase': 'prepared', 'before': {'memory.json': text}})
        write_json(self.memory.file, {})
        self.assertTrue(recover_session(self.config))
        self.assertEqual(Memory(self.config.data_dir).get('g100')[0]['content'], '崩溃前')
        write_json(self.sessions.journal, {'version': 1, 'phase': 'prepared', 'before': {'../escape': 'bad'}})
        with self.assertRaises(ValueError): recover_session(self.config)
        self.assertFalse((self.config.data_dir.parent / 'escape').exists())

    def test_corrupt_partition_and_reserved_names_are_rejected(self):
        for name in ['../坏', 'CON', 'a.', 'a/b', '']:
            with self.assertRaises(ValueError): self.sessions.save(name, '正文')
        self.sessions.activate('甲'); self.remember('原记忆')
        import hashlib
        file = self.config.data_dir / ('memory__'+hashlib.sha256('乙'.encode()).hexdigest()+'.json')
        write_json(file, {'chats': {'g100': [{'content': 1}]}})
        with self.assertRaises(ValueError): self.sessions.activate('乙')
        self.assertEqual(self.memory.get('g100')[0]['content'], '原记忆')

    def test_greetings_bound_to_content_and_exports_contain_no_memory(self):
        library = GreetingLibrary(self.config.data_dir / 'persona-greetings.json')
        library.set('甲正文', {'goodmorning': ['早呀'], 'goodnight': ['安静时段来了，晚安']})
        self.assertIsNone(library.get('乙正文'))
        with self.assertRaises(ValueError): library.set('乙正文', library.get('甲正文'))
        admin = Admin(self.config, PluginManager(self.root, self.config), self.memory, self.long)
        self.remember('不应导出')
        bundle = json.loads(admin.export_persona_package({'name': '甲', 'content': '甲正文'})['content'])
        self.assertEqual(bundle['greetings']['goodmorning'], ['早呀'])
        self.assertNotIn('不应导出', json.dumps(bundle, ensure_ascii=False))

    def test_memory_ui_revision_and_long_text_field(self):
        self.remember('第一条')
        admin = Admin(self.config, PluginManager(self.root, self.config), self.memory, self.long)
        detail = admin.memory_detail({'key': 'g100'})
        self.memory.push('g100', 'user', '新消息')
        with self.assertRaises(ValueError): admin.memory_update({'key': 'g100', 'index': 0, 'content': '过期编辑', 'revision': detail['revision']})
        admin.memory_update({'key': 'g100', 'index': 0, 'content': '新编辑', 'revision': admin.memory_detail({'key': 'g100'})['revision']})
        admin.long_update({'key': 'g100', 'text': '手工摘要'})
        self.assertEqual(self.long.record('g100')['summary'], '手工摘要')
        self.assertTrue(self.long.record('g100')['paused'])

    def test_import_requires_persona_and_validates_before_mutation(self):
        self.remember('保留')
        admin = Admin(self.config, PluginManager(self.root, self.config), self.memory, self.long)
        for data in [{'persona': '不同', 'memory': {}}, {'memory': {'../bad': []}}, {'longMemory': {'g100': {'summary': 1, 'pending': []}}}]:
            with self.assertRaises(ValueError): admin.memory_import({'data': data})
        self.assertEqual(self.memory.get('g100')[0]['content'], '保留')
        admin.memory_import({'data': {'memory': {'g100': [{'role': 'user', 'content': '导入', 'time': 1}]}, 'longMemory': {}}})
        self.assertEqual(self.memory.get('g100')[0]['content'], '导入')
        self.assertEqual(Memory(self.config.data_dir).get('g100')[0]['content'], '导入')

    def test_archive_js_format_dedup_and_epoch_isolation(self):
        archive = MemoryArchive(self.config.data_dir / 'long-memory.json.records')
        item = {'role': 'user', 'content': '下周三完成项目演示', 'senderName': '群友', 'messageId': 1, 'time': 1}
        archive.add('legacy', 'g100', [item, item]); archive.add('legacy', 'g100', [item])
        self.assertEqual(len(archive.entries('legacy', 'g100')), 1)
        self.assertIn('下周三完成项目演示', archive.retrieve('legacy', 'g100', '项目演示'))
        self.assertEqual(archive.retrieve('new', 'g100', '项目演示'), '')
        self.assertEqual(archive.retrieve('legacy', 'p200', '项目演示'), '')

    def test_patch_clamps_without_accepting_unrecognized_fields(self):
        value = normalize_patch({'proactiveRate': 2, 'replyMaxLines': 99, 'admin': True, 'personaDigest': 'forged'})
        self.assertEqual(value, {'proactiveRate': 1, 'replyMaxLines': 5})


class BackupTests(unittest.TestCase):
    setUp = SessionTests.setUp
    tearDown = SessionTests.tearDown
    remember = SessionTests.remember
    def test_completed_backup_restore_and_integrity(self):
        self.remember('原记忆')
        backup = Backup(self.config); saved = backup.run()
        self.remember('新记忆')
        backup.queue_restore(saved['name'])
        self.assertTrue(backup.apply_pending())
        self.assertEqual(Memory(self.config.data_dir).get('g100')[0]['content'], '原记忆')
        source = Path(saved['dir']) / 'memory.json'
        source.write_text('{}', encoding='utf-8')
        with self.assertRaises(ValueError): backup.queue_restore(saved['name'])

    def test_restore_interrupt_rolls_back_and_requires_review(self):
        self.remember('原记忆'); backup = Backup(self.config); saved = backup.run()
        self.memory.clear('g100'); self.remember('恢复前')
        backup.queue_restore(saved['name'])
        original = __import__('koukou.backup', fromlist=['copy']).copy
        failures = [False]
        def failing(source, target):
            if source.parent.name == 'content' and not failures[0]:
                failures[0] = True
                raise OSError('模拟恢复写入失败')
            return original(source, target)
        with patch('koukou.backup.copy', side_effect=failing):
            with self.assertRaises(OSError): backup.apply_pending()
        self.assertEqual(Memory(self.config.data_dir).get('g100')[0]['content'], '恢复前')
        self.assertEqual(read_json(self.config.data_dir / 'restore-pending.json')['phase'], 'failed')
        with self.assertRaises(ValueError): backup.apply_pending()

    def test_backup_names_and_persona_mismatch_rejected(self):
        self.remember('记忆'); backup = Backup(self.config); saved = backup.run()
        with self.assertRaises(ValueError): backup.queue_restore('../escape')
        self.config.values['ACTIVE_PERSONA'] = '不同'
        with self.assertRaises(ValueError): backup.queue_restore(saved['name'])


if __name__ == '__main__': unittest.main()
