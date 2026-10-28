"""Console workflows against generic temporary data; no model or QQ access."""
from datetime import datetime
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

from koukou.admin import Admin
from koukou.backup import ConversationDeletion, recover_conversation_deletion
from koukou.config import Config
from koukou.memory import Memory, LongMemory
from koukou.observability import CHINA
from koukou.plugins import PluginManager
from koukou.sessions import recover_session
from koukou.state import read_json, write_json, write_text


class AdminContractTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        self.config=Config(self.root,environ={})
        self.memory=Memory(self.config.data_dir)
        self.long=LongMemory(self.config.data_dir)
        self.admin=Admin(self.config,PluginManager(self.root,self.config),self.memory,self.long)

    def tearDown(self):
        self.temp.cleanup()

    def archive(self,group,day='2026-01-02',text='generic archived message'):
        file=self.config.data_dir/'daily'/str(group)/(day+'.jsonl')
        write_text(file,json.dumps({'id':'1','time':1,'userId':'200','text':text})+'\n')
        return file

    def remember(self,key):
        self.memory.push(key,'user','generic recent message')
        self.long.edit(key,'generic summary',paused=True)
        self.admin.settings[key]={'note':'generic note'}
        write_json(self.admin.chat_file,self.admin.settings)

    def test_delete_copies_actual_archive_and_removes_only_target(self):
        self.config.save({'WHITELIST_GROUPS':'100,200'})
        self.remember('g100');self.remember('g200')
        file=self.archive(100);other=self.archive(200)
        original=file.read_bytes()
        result=self.admin.delete_chat({'key':'g100'})
        self.assertFalse(file.exists())
        self.assertTrue(other.exists())
        self.assertEqual((Path(result['dailyBackup'])/'100'/file.name).read_bytes(),original)
        self.assertEqual(self.memory.get('g100'),[])
        self.assertEqual(self.long.record('g100')['summary'],'')
        self.assertNotIn('g100',self.admin.settings)
        self.assertEqual(self.config.ids('WHITELIST_GROUPS'),{200})
        self.assertTrue(result['whitelistRemoved'])
        self.assertFalse((self.config.data_dir/'conversation-delete-pending.json').exists())
        self.assertNotIn('g100',{item['key'] for item in self.admin.get_chats({})['items']})

    def test_cleanup_includes_archive_only_groups_and_one_batch(self):
        self.config.save({'WHITELIST_GROUPS':'200'})
        file=self.archive(100);keep=self.archive(200)
        self.remember('g300');self.remember('p400')
        result=self.admin.cleanup_groups({})
        self.assertEqual(result['removed'],['g100','g300'])
        self.assertFalse(file.exists());self.assertTrue(keep.exists())
        self.assertTrue(self.memory.get('p400'))
        self.assertEqual((Path(result['dailyBackup'])/'100'/file.name).read_bytes(),
                         (Path(result['dailyBackup']).parent/'removed'/'100'/file.name).read_bytes())
        self.assertEqual(len(self.admin.backup.list()),1)

    def test_private_delete_has_no_fake_daily_backup_and_invalid_ids_cannot_mutate(self):
        self.remember('p400')
        for key in ['g0','p000','g١٢٣','../100','g-100','g123/../200']:
            with self.subTest(key=key),self.assertRaises(ValueError): self.admin.delete_chat({'key':key})
        self.assertTrue(self.memory.get('p400'))
        result=self.admin.delete_chat({'key':'p400'})
        self.assertIsNone(result['dailyBackup'])
        self.assertEqual(self.memory.get('p400'),[])

    def test_archive_backup_failure_leaves_all_original_state(self):
        self.remember('g100');file=self.archive(100)
        before=self.memory.snapshot()
        from koukou import backup
        original=backup.copy
        def fail(source,target):
            if source.parent.name=='daily': raise OSError('simulated archive copy failure')
            return original(source,target)
        with patch('koukou.backup.copy',side_effect=fail):
            with self.assertRaises(OSError): self.admin.delete_chat({'key':'g100'})
        self.assertTrue(file.exists())
        self.assertEqual(self.memory.snapshot(),before)

    def test_failure_after_archive_move_rolls_back_memory_env_and_archive(self):
        self.config.save({'WHITELIST_GROUPS':'100'})
        self.remember('g100');file=self.archive(100)
        before=self.memory.snapshot();original=file.read_bytes()
        from koukou import sessions
        write=sessions.write_json
        def fail(path,value):
            if Path(path)==self.admin.sessions.journal and value.get('phase')=='committed':
                raise OSError('simulated commit failure after archive rename')
            return write(path,value)
        with patch('koukou.sessions.write_json',side_effect=fail):
            with self.assertRaises(OSError): self.admin.delete_chat({'key':'g100'})
        self.assertEqual(self.memory.snapshot(),before)
        self.assertEqual(file.read_bytes(),original)
        self.assertEqual(self.config.ids('WHITELIST_GROUPS'),{100})
        self.assertFalse((self.config.data_dir/'conversation-delete-pending.json').exists())

    def test_crash_between_file_transaction_commit_and_archive_completion_rolls_back(self):
        self.remember('g100');file=self.archive(100)
        original=file.read_bytes()
        deletion=ConversationDeletion(self.config);deletion.prepare(['g100'])
        before=None
        def mutate():
            nonlocal before
            before=read_json(self.admin.sessions.journal)['before']
            self.memory.clear('g100');self.long.clear('g100')
            deletion.stage_archives(read_json(self.admin.sessions.journal))
        self.admin.sessions.transaction('simulated deletion',mutate)
        self.assertFalse(file.exists());self.assertFalse(self.admin.sessions.journal.exists())
        self.assertTrue(recover_conversation_deletion(self.config))
        self.assertEqual(file.read_bytes(),original)
        self.assertEqual(self.memory.file.read_text(encoding='utf-8'),before['memory.json'])
        self.assertFalse(recover_session(self.config))
        self.assertTrue(Memory(self.config.data_dir).get('g100'))

    def test_recovery_validates_backup_before_any_restore(self):
        self.remember('g100');file=self.archive(100)
        deletion=ConversationDeletion(self.config);path=Path(deletion.prepare(['g100']))
        write_text(path/'100'/file.name,'corrupt backup')
        before=file.read_bytes()
        with self.assertRaises(ValueError): recover_conversation_deletion(self.config)
        self.assertEqual(file.read_bytes(),before)
        self.assertTrue((self.config.data_dir/'conversation-delete-pending.json').exists())

    def test_partial_batch_move_rolls_back_all_targets(self):
        self.remember('g100');self.remember('g200')
        first=self.archive(100);second=self.archive(200)
        before=self.memory.snapshot()
        original=Path.rename
        def fail(path,target):
            if path.parent.name=='daily' and path.name=='200':
                raise OSError('simulated second archive move failure')
            return original(path,target)
        with patch.object(Path,'rename',fail):
            with self.assertRaises(OSError):self.admin.cleanup_groups({})
        self.assertTrue(first.exists());self.assertTrue(second.exists())
        self.assertEqual(self.memory.snapshot(),before)
        self.assertFalse((self.config.data_dir/'conversation-delete-pending.json').exists())

    def test_prepared_session_journal_and_archive_recovery_are_idempotent(self):
        self.remember('g100');file=self.archive(100)
        original=file.read_bytes()
        deletion=ConversationDeletion(self.config);deletion.prepare(['g100'])
        captured=None
        def mutate():
            nonlocal captured
            captured=read_json(self.admin.sessions.journal)
            self.memory.clear('g100');self.long.clear('g100')
            deletion.stage_archives(captured)
        self.admin.sessions.transaction('simulated deletion',mutate)
        # Simulate a crash before the session commit marker, then execute the
        # production startup order twice to ensure neither originals nor resets
        # can be resurrected/discarded by overlapping recovery journals.
        write_json(self.admin.sessions.journal,captured)
        self.assertTrue(recover_conversation_deletion(self.config))
        self.assertTrue(recover_session(self.config))
        self.assertFalse(recover_conversation_deletion(self.config))
        self.assertFalse(recover_session(self.config))
        self.assertEqual(file.read_bytes(),original)
        self.assertTrue(Memory(self.config.data_dir).get('g100'))

    def test_changed_original_blocks_deletion_before_any_archive_move(self):
        file=self.archive(100)
        deletion=ConversationDeletion(self.config);deletion.prepare(['g100'])
        with file.open('a',encoding='utf-8') as stream:stream.write('{"text":"new record"}\n')
        changed=file.read_bytes()
        transaction={'version':1,'phase':'prepared','before':{}}
        with self.assertRaises(ValueError):deletion.stage_archives(transaction)
        self.assertEqual(file.read_bytes(),changed)
        self.assertFalse((deletion.stage/'removed').exists())

    def test_archive_links_are_rejected_without_mutating_external_files(self):
        external=self.root/'outside';external.mkdir()
        file=external/'original.jsonl';write_text(file,'original')
        daily=self.config.data_dir/'daily';daily.mkdir(parents=True,exist_ok=True)
        link=daily/'100'
        try:link.symlink_to(external,target_is_directory=True)
        except OSError:self.skipTest('creating directory links is unavailable')
        self.remember('g100');before=self.memory.snapshot()
        with self.assertRaises(ValueError):self.admin.delete_chat({'key':'g100'})
        self.assertEqual(file.read_text(encoding='utf-8'),'original')
        self.assertEqual(self.memory.snapshot(),before)

    def test_frontend_literal_api_calls_have_native_routes(self):
        source=Path(__file__).resolve().parents[2]/'src'/'admin'
        paths=set()
        for file in [*source.glob('*.js'),*source.glob('*.html')]:
            paths.update(re.findall(r"['\"](/api/[a-zA-Z0-9_/-]+)(?:[?'\"])",file.read_text(encoding='utf-8-sig')))
        paths={path for path in paths if not path.endswith('/')}
        gets=set(self.admin.gets)|{'/api/sticker-file','/api/sticker-blacklist-file'}
        actions={'/api/action/'+name for name in self.admin.actions}
        self.assertFalse(paths-gets-actions,sorted(paths-gets-actions))
        # These use a conditional/string suffix in the frontend, so literal-only
        # extraction cannot discover their full path.
        self.assertTrue({'longmemory-pause','longmemory-resume','save-builtin-command','restart-bot','restart-napcat'}<=set(self.admin.actions))

    def test_console_counts_and_diagnostics_match_frontend_shape(self):
        self.config.save({'WHITELIST_GROUPS':'100'})
        self.remember('g100');self.remember('p400')
        today=datetime.now(CHINA).strftime('%Y-%m-%d')
        file=self.archive(100,today)
        with file.open('a',encoding='utf-8') as stream:stream.write('{}\n')
        self.admin.runtime_stats.note_message('g100',123)
        self.admin.runtime_stats.note_reply('g100')
        self.admin.group_members['100']=8
        self.admin.poke_diagnostics={'lastNoticeAt':123}
        rows={item['key']:item for item in self.admin.get_chats({})['items']}
        row=rows['g100']
        self.assertEqual([row[k] for k in ['msgToday','replies','received','lastActive','members']],[2,1,1,123,8])
        self.assertEqual(rows['p400']['msgToday'],1)
        self.assertEqual(self.admin.get_commands({})['poke'],{'lastNoticeAt':123})


if __name__=='__main__':unittest.main()
