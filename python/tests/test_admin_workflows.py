"""Real HTTP payload/response workflows used by the retained browser frontend."""
import asyncio
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import quote
from aiohttp.test_utils import TestClient,TestServer

from koukou.admin import Admin
from koukou.config import Config
from koukou.memory import Memory,LongMemory
from koukou.plugins import PluginManager
from koukou.sessions import digest
from koukou.state import read_json,write_json
from koukou.summary_basics import SummaryProgress
from koukou.rate_limit import RateLimiter

PNG='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1kAAAAASUVORK5CYII='


class TagModel:
    model='offline-vision-fixture'
    def __init__(self):
        self.calls=[];self.started=asyncio.Event();self.release=None

    async def describe(self,*args,**kwargs):
        self.calls.append((args,kwargs));self.started.set()
        if self.release:await self.release.wait()
        return json.dumps({'isSticker':True,'name':'fixture name','keywords':['fixture','happy'],
                           'description':'fixture description','scenes':['happy']})


class SummaryFixture:
    def __init__(self,file):
        self.progress=SummaryProgress(file);self.calls=[]

    def trigger(self,groups,**kwargs):
        groups=[10001] if groups is None else list(map(int,groups))
        self.calls.append((groups,kwargs))
        for group in groups:self.progress.start(group,days=kwargs.get('days',1))
        return {'ok':True,'groups':groups,'busy':[],'progress':list(self.progress.items.values())}

    async def close(self):pass


class AdminWorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory()
        self.root=Path(self.temp.name)
        repo=Path(__file__).resolve().parents[2]
        self.config=Config(repo,self.root/'.env',environ={'BOT_DATA_DIR':str(self.root/'data'),'BOT_LOG_DIR':str(self.root/'logs')})
        self.memory=Memory(self.config.data_dir);self.long=LongMemory(self.config.data_dir)
        self.plugins=PluginManager(self.root,self.config)
        self.tag=TagModel()
        self.admin=Admin(self.config,self.plugins,self.memory,self.long,sticker_tag_model=self.tag)
        self.client=TestClient(TestServer(self.admin.app()));await self.client.start_server()

    async def asyncTearDown(self):
        await self.client.close();self.temp.cleanup()

    async def post(self,action,payload):
        response=await self.client.post('/api/action/'+action,json=payload,headers={'X-Admin-Token':self.admin.token})
        body=await response.json()
        return response.status,body

    async def get(self,path):
        response=await self.client.get(path)
        self.assertEqual(response.status,200,await response.text())
        return await response.json()

    async def test_persona_import_export_greetings_and_optional_activation(self):
        content='generic persona content'
        greetings={'personaHash':digest(content),'goodmorning':['generic morning'],'goodnight':['generic night']}
        self.memory.push('g10001','user','original recent record')
        status,result=await self.post('import-persona',{'name':'fixture-persona','content':content,'greetings':greetings})
        self.assertEqual(status,200,result)
        self.assertEqual(result['name'],'fixture-persona');self.assertEqual(result['content'],content)
        self.assertEqual(self.config.get('ACTIVE_PERSONA'),'')
        self.assertTrue(self.memory.get('g10001'))
        fetched=await self.get('/api/personas')
        self.assertFalse(fetched['items'][0]['active']);self.assertIn('mtime',fetched['items'][0])
        status,result=await self.post('get-greeting-library',{'content':content})
        self.assertEqual(result['library'],greetings)
        status,exported=await self.post('export-persona-package',{'name':'fixture-persona','content':content})
        self.assertEqual(status,200,exported)
        bundle=json.loads(exported['content'])
        self.assertEqual(exported['filename'],'Koukou-fixture-persona-人格.json')
        self.assertEqual(bundle,{'format':'koukou-persona','version':1,'name':'fixture-persona','content':content,'greetings':greetings})
        self.assertNotIn('original recent record',exported['content'])
        status,result=await self.post('activate-persona',{'name':'fixture-persona'})
        self.assertEqual(status,200,result);self.assertTrue(result['changed'])
        self.assertEqual(self.memory.get('g10001'),[])
        self.assertEqual((await self.get('/api/personas'))['items'][0]['active'],True)
        status,result=await self.post('get-greeting-library',{'content':content+' changed'})
        self.assertIsNone(result['library'])

    async def test_failed_persona_library_write_leaves_import_retryable(self):
        content='new generic persona';library={'personaHash':digest(content),'goodmorning':['hello'],'goodnight':['night']}
        before=self.admin.greetings.state.copy()
        with patch.object(self.admin.greetings,'set',side_effect=OSError('simulated library failure')):
            status,result=await self.post('import-persona',{'name':'retry-persona','content':content,'greetings':library})
        self.assertEqual(status,400,result)
        self.assertFalse(self.admin.sessions.path('retry-persona').exists())
        self.assertEqual(self.admin.greetings.state,before)
        status,result=await self.post('import-persona',{'name':'retry-persona','content':content,'greetings':library})
        self.assertEqual(status,200,result)
        status,result=await self.post('import-persona',{'name':'retry-persona','content':'different','greetings':None})
        self.assertEqual(status,400,result)
        self.assertEqual(self.admin.sessions.read('retry-persona'),content)

    async def test_plugin_recall_settings_alias_and_delete_match_frontend(self):
        settings=self.plugins.directory/'settings.json'
        write_json(settings,{'recallMinutes':'2.5','recallEnabled':True,'names':{},'futureSetting':'retain me'})
        result=await self.get('/api/python-scripts')
        self.assertEqual(result['settings']['recallSeconds'],150)
        status,result=await self.post('save-python-settings',{'recallMinutes':.5,'recallEnabled':False})
        self.assertEqual(status,200,result);self.assertEqual(result['settings']['recallSeconds'],30)
        self.assertFalse(result['settings']['recallEnabled'])
        self.assertEqual(read_json(settings)['futureSetting'],'retain me')
        status,result=await self.post('save-python-settings',{'recallSeconds':30.5,'recallEnabled':True})
        self.assertEqual(status,200,result);self.assertEqual(result['settings']['recallSeconds'],31)
        before=settings.read_bytes()
        status,result=await self.post('save-python-settings',{'recallSeconds':7201})
        self.assertEqual(status,400,result);self.assertEqual(settings.read_bytes(),before)
        status,result=await self.post('import-python-script',{'filename':'fixture.py','content':'# usage: /fixture content\nprint("fixture")\n'})
        self.assertEqual(status,200,result)
        status,result=await self.post('set-python-command',{'id':'fixture','command':'示例'})
        self.assertEqual(status,200,result);self.assertEqual(result['command'],'示例')
        plugins=await self.get('/api/python-scripts')
        self.assertTrue(plugins['nativeCommands']);self.assertEqual(plugins['items'][0]['usage'],'/示例 content')
        commands=await self.get('/api/custom-commands')
        self.assertIn('plugin:fixture',{item['id'] for item in commands['builtinItems']})
        status,result=await self.post('toggle-python-script',{'id':'fixture','enabled':False})
        self.assertFalse(result['enabled'])
        status,result=await self.post('import-python-script',{'filename':'fixture.py','content':'print("updated fixture")\n'})
        self.assertTrue(self.plugins.path('fixture').with_suffix('.py.bak').exists())
        status,result=await self.post('delete-python-script',{'id':'fixture'})
        self.assertEqual(status,200,result)
        self.assertFalse(self.plugins.path('fixture').exists());self.assertFalse(self.plugins.path('fixture').with_suffix('.py.bak').exists())

    async def test_sticker_upload_ai_draft_blacklist_preview_and_unblock_roundtrip(self):
        listing=await self.get('/api/stickers');token=listing['persona']['token']
        status,result=await self.post('sticker-suggest',{'stickerScope':token,'dataUrl':PNG})
        self.assertEqual(status,200,result)
        draft=result['draft'];self.assertEqual(draft['model'],self.tag.model)
        self.assertIsInstance(draft['keywords'],list);self.assertEqual(draft['scenes'],['happy'])
        self.assertEqual((await self.get('/api/stickers'))['items'],[])
        payload={'stickerScope':token,'dataUrl':PNG,**{key:draft[key] for key in ['name','keywords','description','scenes']}}
        status,result=await self.post('sticker-add',payload)
        self.assertEqual(status,200,result);self.assertFalse(result['duplicated'])
        item=result['item'];self.assertEqual(result['count'],1)
        status,result=await self.post('sticker-add',payload)
        self.assertTrue(result['duplicated']);self.assertEqual(result['count'],1)
        response=await self.client.get('/api/sticker-file',params={'scope':token,'id':item['id'],'hash':item['hash']})
        self.assertEqual(response.status,200);self.assertEqual(response.content_type,'image/png')
        original=await response.read()
        status,result=await self.post('sticker-blacklist',{'stickerScope':token,'id':item['id']})
        self.assertEqual(status,200,result);self.assertEqual(result['count'],0)
        listing=await self.get('/api/stickers')
        self.assertEqual(listing['items'],[]);self.assertTrue(listing['blacklist'][0]['hasPreview'])
        response=await self.client.get('/api/sticker-blacklist-file',params={'scope':token,'hash':item['hash']})
        self.assertEqual(await response.read(),original)
        status,result=await self.post('sticker-add',payload)
        self.assertEqual(status,400,result)
        status,result=await self.post('sticker-unblock',{'stickerScope':token,'hash':item['hash']})
        self.assertEqual(status,200,result)
        listing=await self.get('/api/stickers');self.assertEqual(listing['items'],[]);self.assertEqual(listing['blacklist'],[])
        status,result=await self.post('sticker-add',payload)
        self.assertEqual(status,200,result);self.assertEqual(result['count'],1)

    async def test_stale_persona_cannot_save_an_old_upload_or_ai_result(self):
        token=(await self.get('/api/stickers'))['persona']['token']
        self.tag.release=asyncio.Event()
        request=asyncio.create_task(self.post('sticker-suggest',{'stickerScope':token,'dataUrl':PNG}))
        await self.tag.started.wait()
        await self.post('create-persona',{'name':'other','content':'other generic persona'})
        await self.post('activate-persona',{'name':'other'})
        self.tag.release.set()
        status,result=await request
        self.assertEqual(status,400,result)
        status,result=await self.post('sticker-add',{'stickerScope':token,'dataUrl':PNG})
        self.assertEqual(status,400,result)
        self.assertEqual((await self.get('/api/stickers'))['items'],[])

    async def test_retag_http_job_never_overwrites_an_edit_made_during_ai_wait(self):
        token=(await self.get('/api/stickers'))['persona']['token']
        status,result=await self.post('sticker-add',{'stickerScope':token,'dataUrl':PNG,'name':'original title','keywords':'original','description':'original description','scenes':['happy']})
        id=result['item']['id']
        self.tag.release=asyncio.Event()
        status,result=await self.post('retag-stickers',{'stickerScope':token})
        self.assertEqual(status,200,result);self.assertEqual(result['total'],1)
        await self.tag.started.wait()
        status,result=await self.post('sticker-update',{'stickerScope':token,'id':id,'description':'manual edit while AI is waiting'})
        self.assertEqual(status,200,result)
        self.tag.release.set()
        await asyncio.gather(*list(self.admin.background))
        job=await self.get('/api/stickers/retag-status?scope='+quote(token,safe=''))
        self.assertFalse(job['running']);self.assertEqual(job['done'],1);self.assertEqual(job['skipped'],1)
        listing=await self.get('/api/stickers')
        self.assertEqual(listing['items'][0]['description'],'manual edit while AI is waiting')
        self.assertEqual(listing['items'][0]['name'],'original title')

    async def test_summary_status_and_acknowledgement_cannot_clear_newer_job(self):
        service=SummaryFixture(self.config.data_dir/'test-summary-progress.json');self.admin.summaries=service
        status,result=await self.post('summary',{'groupId':10001,'days':2})
        self.assertEqual(status,200,result);self.assertEqual(result['groups'],[10001])
        progress=result['progress'][0]
        self.assertEqual(progress['status'],'generating');self.assertEqual(progress['days'],2)
        job=progress['jobId']
        service.progress.update(10001,job,status='success',message='fixture complete',resultKind='statistics')
        state=await self.get('/api/state')
        self.assertEqual(state['summaryProgress'][0]['resultKind'],'statistics')
        status,result=await self.post('summary-ack',{'groupId':10001,'jobId':'older job'})
        self.assertFalse(result['acknowledged']);self.assertEqual(result['progress'][0]['status'],'success')
        status,result=await self.post('summary-ack',{'groupId':10001,'jobId':job})
        self.assertTrue(result['acknowledged']);self.assertEqual(result['progress'][0]['status'],'idle')

    async def test_summary_missing_check_returns_while_background_work_is_running(self):
        started,release=asyncio.Event(),asyncio.Event()
        calls=[]
        async def run_slot(clock,**kwargs):
            calls.append((clock,kwargs));started.set();await release.wait()
        service=SummaryFixture(self.config.data_dir/'test-summary-progress.json')
        service.schedule=SimpleNamespace(enabled=lambda:True,run_slot=run_slot)
        self.admin.summaries=service
        status,result=await asyncio.wait_for(self.post('summary',{'missingOnly':True,'groupId':10001,'statsOnly':True}),2)
        self.assertEqual(status,200,result);self.assertTrue(result['replacesFallback'])
        await started.wait();self.assertFalse(release.is_set())
        self.assertEqual(calls,[('23:30',{'early_fallback':True,'group_ids':[10001],'stats_only':True})])
        release.set();await asyncio.gather(*list(self.admin.background))

    async def test_state_contains_effective_fields_used_by_retained_frontend(self):
        self.config.save({'WHITELIST_GROUPS':'10001','PRIVATE_WHITELIST':'20002','ADMIN_USERS':'30003',
                          'VISION_PROVIDER':'deepseek','VISION_MODEL':'deepseek-flash','VISION_REASONING':'none','VISION_MAX_TOKENS':'300',
                          'DEEPSEEK_API_KEY':'offline-only-placeholder','SUMMARY_UNRESTRICTED':'1','REPLY_TIMING_ENABLED':'1',
                          'PROACTIVE_RATE_PER_GROUP':'10001:0.4,10002:0.8','SUMMARY_GROUPS':'10002'})
        result=await self.get('/api/state');state=result['config']
        self.assertEqual(state['whitelist'],[10001]);self.assertEqual(state['privateWhitelist'],[20002]);self.assertEqual(state['adminUsers'],[30003])
        self.assertEqual(state['visionProvider'],'deepseek');self.assertEqual(state['visionModelDeepseek'],'deepseek-flash')
        self.assertEqual(state['visionReasoning'],'max');self.assertEqual(state['rawVisionReasoning'],'none')
        self.assertEqual(state['visionMaxTokens'],2048);self.assertEqual(state['rawVisionMaxTokens'],300)
        self.assertTrue(state['summaryUnrestricted']);self.assertEqual(state['summaryGroups'],[10002])
        self.assertIsNone(state['summaryActiveLimits']['maxOutputTokens']);self.assertTrue(state['replyTimingEnabled'])
        self.assertEqual(state['proactiveRatePerGroup'],[{'groupId':10001,'rate':.4},{'groupId':10002,'rate':.8}])
        self.assertEqual(result['bot']['visionModel'],'deepseek-flash')
        self.assertNotIn('offline-only-placeholder',json.dumps(result))
        self.assertEqual(result['replies'],{})
        self.assertTrue(result['version'].endswith('-python-migration'))

    async def test_form_defaults_display_native_effective_values_without_writing_config(self):
        self.assertFalse(self.config.env_file.exists())
        before={str(path.relative_to(self.root)):path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        result=await self.get('/api/config');fields={item['key']:item for item in result['items']}
        expected={'PROACTIVE_RATE':'0.04','HISTORY_LIMIT':'99','STICKER_AUTO_RATE':'35','STICKERS_ENABLED':'1',
                  'STICKER_LEARN_ENABLED':'0','STICKER_LEARN_PRIVATE':'0','POKE_REPLY_ENABLED':'1','AUTO_PLUS_ONE_ENABLED':'0',
                  'REPLY_TIMING_ENABLED':'0','SUMMARY_ENABLED':'1','SUMMARY_UNRESTRICTED':'1','SUMMARY_REQUEST_TIMEOUT_SECONDS':'900',
                  'SUMMARY_MAX_MESSAGES':'600','SUMMARY_TASK_TIMEOUT_MINUTES':'6','DEEPSEEK_REASONING_EFFORT':'max',
                  'VISION_PROVIDER':'dashscope','VISION_MAX_TOKENS':'300','FILE_UPLOAD_MAX_MB':'1024','ARCHIVE_FORMAT':'zip'}
        for key,value in expected.items():
            self.assertEqual(fields[key]['effective'],value,key);self.assertEqual(fields[key]['value'],'',key)
        limiter=RateLimiter.from_config(self.config)
        self.assertEqual(float(fields['RATE_LIMIT_PER_HOUR']['effective']),limiter.per_hour)
        self.assertEqual(float(fields['RATE_LIMIT_MIN_GAP_MS']['effective']),limiter.min_gap_ms)
        self.assertEqual(fields['DEEPSEEK_API_KEY']['value'],'');self.assertEqual(fields['DEEPSEEK_API_KEY']['effective'],'')
        self.assertFalse(fields['DEEPSEEK_API_KEY']['configured'])
        after={str(path.relative_to(self.root)):path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        self.assertEqual(before,after)

    async def test_form_separates_saved_values_from_process_overrides_and_paused_learning(self):
        self.config.save({'PROACTIVE_RATE':'.2','STICKER_LEARN_ENABLED':'1'})
        self.config.environ['PROACTIVE_RATE']='.7';self.config.values['PROACTIVE_RATE']='.7'
        self.config.values['DEEPSEEK_API_KEY']='offline-secret-placeholder'
        store=self.admin.stickers.for_chat()
        write_json(store.learning_file,{'pausedByCapacity':True})
        self.admin.stickers.libraries.clear()
        before={str(path.relative_to(self.root)):path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        result=await self.get('/api/config');fields={item['key']:item for item in result['items']}
        self.assertEqual(fields['PROACTIVE_RATE']['value'],'.2');self.assertEqual(fields['PROACTIVE_RATE']['effective'],'0.7')
        self.assertEqual(fields['STICKER_LEARN_ENABLED']['value'],'1');self.assertEqual(fields['STICKER_LEARN_ENABLED']['effective'],'0')
        self.assertTrue(fields['DEEPSEEK_API_KEY']['configured']);self.assertNotIn('offline-secret-placeholder',json.dumps(result))
        after={str(path.relative_to(self.root)):path.read_bytes() for path in self.root.rglob('*') if path.is_file()}
        self.assertEqual(before,after)

    async def test_quick_config_switch_updates_stored_command_toggle(self):
        token=(await self.get('/api/stickers'))['persona']['token']
        status,result=await self.post('save-builtin-command',{'id':'poke','enabled':False,'responseMode':'ai'})
        self.assertEqual(status,200,result)
        status,result=await self.post('set-config-batch',{'patch':{'POKE_REPLY_ENABLED':'1','AUTO_PLUS_ONE_ENABLED':'1'}})
        self.assertEqual(status,200,result)
        items={item['id']:item for item in (await self.get('/api/custom-commands'))['builtinItems']}
        self.assertTrue(items['poke']['enabled']);self.assertEqual(items['poke']['responseMode'],'ai')
        self.assertTrue(items['auto-plus-one']['enabled'])
        self.assertEqual((await self.get('/api/stickers'))['persona']['token'],token)
        status,result=await self.post('set-config',{'key':'POKE_REPLY_ENABLED','value':'0'})
        self.assertEqual(status,200,result)
        self.assertFalse(self.admin.commands.get('poke')['enabled'])

    async def test_quick_config_failure_restores_env_and_stored_command(self):
        await self.post('save-builtin-command',{'id':'poke','enabled':False,'responseMode':'ai'})
        self.config.save({'POKE_REPLY_ENABLED':'0'})
        before=self.config.env_file.read_bytes()
        with patch.object(self.admin.commands,'save_builtin',side_effect=OSError('simulated command setting failure')):
            status,result=await self.post('set-config',{'key':'POKE_REPLY_ENABLED','value':'1'})
        self.assertEqual(status,400,result)
        self.assertEqual(self.config.env_file.read_bytes(),before)
        self.assertFalse(self.admin.commands.get('poke')['enabled'])
        self.assertEqual(self.config.get('POKE_REPLY_ENABLED'),'0')

    async def test_missing_shipped_version_never_becomes_python_package_release(self):
        with patch('koukou.admin.local_version',side_effect=ValueError('missing version')):
            other=Admin(self.config,self.plugins,self.memory,self.long)
        self.assertIsNone(other.updates)
        self.assertEqual((await other.state({}))['version'],'unknown-python-migration')
        self.assertIsNone((await other.get_updates({}))['currentVersion'])


if __name__=='__main__':unittest.main()
