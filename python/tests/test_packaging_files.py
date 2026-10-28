"""Offline archive formats and explicitly authorized file/link delivery."""
import asyncio
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile
from koukou.config import Config
from koukou.file_commands import FileCommands, parse_file_command
from koukou.media import MediaDelivery
from koukou.onebot import OneBotError
from koukou.packaging import ArchivePacker, local_source, normalize_format, normalize_passes
from koukou.plugins import PluginManager, decode_result


class ArchiveTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.source = self.root/'中文 资料'; self.source.mkdir()
        (self.source/'内容.txt').write_text('完整中文内容',encoding='utf-8')
        self.packer = ArchivePacker(); self.packer.seven_zip_path = ''; self.packer.rar_path = ''

    async def test_native_zip_rounds_preserve_unicode_and_all_extensions(self):
        packed = await self.packer.pack(self.source,passes=2,out_dir=self.root/'out')
        self.assertEqual(packed.name,'中文 资料.2.zip'); self.assertEqual(packed.format,'zip')
        with zipfile.ZipFile(packed.file) as outer:
            first = outer.read('中文 资料.zip')
        with zipfile.ZipFile(io.BytesIO(first)) as inner:
            self.assertEqual(inner.read('中文 资料/内容.txt').decode(),'完整中文内容')
        directory = packed.dir; packed.cleanup(); self.assertFalse(directory.exists()); self.assertTrue(self.source.exists())

    async def test_zip_7z_rar_exact_tool_options_are_shell_free_and_do_not_encrypt(self):
        tool = self.root/'archiver.exe'; tool.write_bytes(b'tool')
        calls = []
        async def runner(command,args,**options):
            calls.append((command,args,options))
            # Windows runners may expose TEMP through an 8.3 alias; compare canonical paths.
            output = next(Path(arg) for arg in args if Path(str(arg)).is_absolute() and Path(arg).resolve().is_relative_to((self.root/'out').resolve()))
            output.write_bytes(b'archive')
        packer = ArchivePacker(run_impl=runner); packer.seven_zip_path = str(tool); packer.rar_path = str(tool)
        for fmt in ['zip','7z','rar']:
            packed = await packer.pack(self.source,format=fmt,passes=2,out_dir=self.root/'out')
            self.assertEqual(packed.format,fmt); self.assertTrue(packed.file.name.endswith('.2.'+fmt)); packed.cleanup()
        for command,args,options in calls:
            self.assertEqual(command,str(tool)); self.assertIn('--',args); self.assertNotIn('-p',args)
            self.assertEqual(options['timeout'],600)
        self.assertEqual(calls[0][1][1],'-tzip'); self.assertEqual(calls[2][1][1],'-t7z'); self.assertIn('-ma5',calls[4][1])

    async def test_missing_tools_oversize_and_cancel_cleanup_only_owned_files(self):
        for fmt in ['7z','rar']:
            with self.assertRaises(ValueError):
                await self.packer.pack(self.source,format=fmt,out_dir=self.root/'out')
        with self.assertRaises(ValueError):
            await self.packer.pack(self.source,out_dir=self.root/'out',max_bytes=1)
        started = asyncio.Event()
        async def pending(*args,**kwargs):
            started.set(); await asyncio.Event().wait()
        self.packer.run_impl = pending
        task = asyncio.create_task(self.packer.pack(self.source,out_dir=self.root/'out'))
        await started.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertFalse(list((self.root/'out').iterdir())); self.assertTrue((self.source/'内容.txt').is_file())

    async def test_symlinks_and_archiving_into_source_are_rejected(self):
        with self.assertRaises(ValueError):
            await self.packer.pack(self.source,out_dir=self.source/'out')
        alias = self.source/'外部文件'
        try:
            alias.symlink_to(self.root/'secret.txt')
        except OSError:
            self.skipTest('Host does not allow creating test symlinks')
        with self.assertRaises(ValueError):
            await self.packer.pack(self.source,out_dir=self.root/'out')

    def test_normalization_and_local_path_boundaries(self):
        self.assertEqual([normalize_format(x) for x in ['RAR',' 7z ','unknown']],['rar','7z','zip'])
        self.assertEqual([normalize_passes(x) for x in [None,0,2.9,99,'nan']],[1,1,2,5,1])
        for value in ['file://server/file','https://example.invalid/x','\\\\server\\file','bad\npath']:
            with self.assertRaises(ValueError):
                local_source(value)
        with self.assertRaises(ValueError):
            local_source(self.source,roots=[self.root/'outside'])


class FileCommandTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name); self.config = Config(self.root,environ={'ADMIN_USERS':'11','QUIET_HOURS':''})
        self.settings = {}; self.at = 1000
        class Protocol:
            self_id = '10'; account_version = 0
            def __init__(self):
                self.sent = []; self.api_calls = []; self.error = None; self.probe = None
            def status(self):
                return {'online':True,'probeVerified':True}
            async def refresh_status(self):
                if self.probe:
                    self.probe()
                return {'online':True,'connected':True}
            async def send(self,key,value,**kwargs):
                self.sent.append((key,value,kwargs))
                if self.error:
                    raise self.error
                return {'message_id':len(self.sent)}
            async def api(self,action,params,**kwargs):
                self.api_calls.append((action,params,kwargs)); return {}
        self.protocol = Protocol()
        outer = self
        class Registry:
            def __init__(self):
                self.rules = {key:{'id':key,'enabled':True,'adminOnly':True} for key in ['send-file','send-link']}
            def get(self,key):
                return dict(self.rules[key])
            def allowed(self,item,event):
                return item['enabled'] and (not item['adminOnly'] or int(event['user_id']) in outer.config.ids('ADMIN_USERS'))
        self.registry = Registry()
        self.media = MediaDelivery(self.config,self.protocol,now=lambda:self.at)
        self.commands = FileCommands(self.config,self.protocol,self.registry,self.media,self.settings,now=lambda:self.at)
        self.file = self.root/'中文 文件.txt'; self.file.write_text('本地文件内容',encoding='utf-8')
        self.event = {'group_id':11111,'user_id':11,'message_id':1}

    async def test_file_uses_media_receipts_one_gb_default_and_recall(self):
        result = await self.commands.handle(self.event,f'/发文件 私聊 22222 "{self.file}"')
        self.assertTrue(result['ok']); self.assertEqual(self.protocol.sent[0][0],'p22222')
        self.assertEqual(self.commands.max_bytes(),1024**3)
        record = next(iter(self.media.records.values())); self.assertEqual(record['recallStatus'],'pending')
        again = await self.commands.handle(self.event,f'/发文件 私聊 22222 "{self.file}"')
        self.assertFalse(again['ok']); self.assertEqual(len(self.protocol.sent),1)

    async def test_non_admin_and_explicit_allowed_directories(self):
        self.registry.rules['send-file']['adminOnly'] = False
        event = {**self.event,'user_id':12}
        result = await self.commands.handle(event,f'/发文件 群 22222 "{self.file}"')
        self.assertFalse(result['ok']); self.assertFalse(self.protocol.sent)
        self.config.values['FILE_SEND_ALLOWED_ROOTS'] = json.dumps([str(self.root)],ensure_ascii=False)
        result = await self.commands.handle(event,f'/发文件 群 22222 "{self.file}"')
        self.assertTrue(result['ok'])

    async def test_oversize_file_is_rejected_before_upload(self):
        with self.file.open('wb') as stream:
            stream.truncate(1024**3+1)
        result = await self.commands.handle(self.event,f'/发文件 群 22222 "{self.file}"')
        self.assertFalse(result['ok']); self.assertFalse(self.protocol.sent)

    async def test_quiet_target_permission_change_or_offline_cannot_send(self):
        self.settings['g22222'] = {'quietHours':'00:00-24:00'}
        result = await self.commands.handle(self.event,f'/发文件 群 22222 "{self.file}"')
        self.assertFalse(result['ok']); self.settings.clear()
        self.protocol.probe = lambda:self.registry.rules['send-file'].update(enabled=False)
        result = await self.commands.handle(self.event,f'/发文件 群 22222 "{self.file}"')
        self.assertFalse(result['ok']); self.assertFalse(self.protocol.sent)

    async def test_directory_confirmed_cleanup_but_unknown_upload_retains_owned_archive(self):
        directory = self.root/'source'; directory.mkdir(); (directory/'text.txt').write_text('content')
        packer = ArchivePacker(); packer.seven_zip_path = ''
        self.commands.packer = packer
        result = await self.commands.handle(self.event,f'/发文件 群 22222 "{directory}"')
        self.assertTrue(result['ok']); self.assertFalse(list(self.commands.temp_root.iterdir()))
        self.event['message_id'] = 2; self.protocol.error = OneBotError('timeout',outcome_unknown=True)
        result = await self.commands.handle(self.event,f'/发文件 群 22222 "{directory}"')
        self.assertFalse(result['ok']); self.assertTrue(result['uncertain']); self.assertTrue(list(self.commands.temp_root.iterdir()))
        self.at += 86401; await self.commands.cleanup()
        self.assertFalse(list(self.commands.temp_root.iterdir())); self.assertTrue(directory.is_dir())

    async def test_link_card_unknown_never_falls_back_and_unsupported_falls_back_at_target(self):
        self.protocol.error = OneBotError('timeout',outcome_unknown=True)
        result = await self.commands.handle(self.event,'/发链接 群 22222 https://example.invalid/x 标题')
        self.assertFalse(result['ok']); self.assertEqual(len(self.protocol.sent),1)
        await self.commands.handle(self.event,'/发链接 群 22222 https://example.invalid/x 标题')
        self.assertEqual(len(self.protocol.sent),1)
        self.event['message_id'] = 2
        original = self.protocol.send
        async def supported(key,value,**kwargs):
            self.protocol.error = OneBotError('unsupported share segment') if isinstance(value,list) else None
            return await original(key,value,**kwargs)
        self.protocol.send = supported
        result = await self.commands.handle(self.event,'/发链接 私聊 33333 https://example.invalid/x 标题')
        self.assertTrue(result['ok']); self.assertEqual(self.protocol.sent[-1][0],'p33333'); self.assertIsInstance(self.protocol.sent[-1][1],str)

    async def test_link_invalid_url_and_failed_intent_persistence_send_nothing(self):
        for url in ['javascript:alert(1)','file:///secret','https://user:password@example.invalid/']:
            result = await self.commands.handle(self.event,'/发链接 群 22222 '+url)
            self.assertFalse(result['ok'])
        with patch('koukou.file_commands.write_json',side_effect=OSError('disk')):
            result = await self.commands.handle(self.event,'/发链接 群 22222 https://example.invalid/')
        self.assertFalse(result['ok']); self.assertFalse(self.protocol.sent)

    async def test_native_sdk_and_legacy_file_payload_share_the_same_file_path(self):
        manager = PluginManager(self.root,self.config)
        manager.import_script('export.py','''from koukou.plugin import plugin,Result
import os
@plugin.command
def handle(args):
    return Result(text='中文 '+os.environ['KOUKOU_FILE_MAX_MB'],files=[args[0]])
if __name__ == '__main__': plugin.run()
''')
        value = decode_result(await manager.run('export',[str(self.file)]))
        self.assertIn('中文 1024',value['text']); self.assertEqual(value['files'],[str(self.file)])
        receipts = await self.media.deliver(self.event,value)
        self.assertEqual(len(receipts),2)
        self.event['message_id'] = 2
        legacy = decode_result({'ok':True,'stdout':'@@FILE@@'+json.dumps({'path':str(self.file),'recall_seconds':5})})
        receipts = await self.media.deliver(self.event,legacy)
        self.assertEqual(len(receipts),1)

    def test_parser_keeps_explicit_server_path_and_target(self):
        value = parse_file_command('/发文件 群 22222 "C:\\文件\\资料.txt"')
        self.assertEqual(value['path'],'"C:\\文件\\资料.txt"'); self.assertEqual(value['targetKey'],'g22222')
        self.assertIsNone(parse_file_command('随便发个文件'))
