import tempfile
import unittest
from pathlib import Path
from koukou.config import Config
from koukou.plugins import PluginManager
from koukou.media import MediaDelivery
from koukou.state import read_json,write_json


class PluginSettingsTests(unittest.IsolatedAsyncioTestCase):
    async def test_legacy_string_minutes_reach_media_and_renaming_keeps_unknown_settings(self):
        with tempfile.TemporaryDirectory() as tmp:
            config=Config(tmp,environ={})
            manager=PluginManager(tmp,config);manager.create('hello')
            file=manager.directory/'settings.json'
            write_json(file,{'recallMinutes':'2.5','futureOption':{'keep':True}})
            before=file.read_bytes()
            self.assertEqual(manager.settings()['recallSeconds'],150)
            self.assertEqual(file.read_bytes(),before)
            manager.set_command('hello','问候')
            self.assertEqual(read_json(file)['futureOption'],{'keep':True})
            class Protocol:
                self_id='200000010'
                async def send(self,*args,**kwargs):return {'message_id':99}
            data=Path(tmp)/'sample.txt';data.write_text('generic fixture',encoding='utf-8')
            media=MediaDelivery(config,Protocol(),manager,now=lambda:1000)
            await media.deliver({'user_id':200000011,'message_id':1},{'files':[str(data)]})
            self.assertTrue(any(item.get('recallAt')==1150 for item in media.records.values()))

    async def test_settings_normalization_never_writes_bad_or_legacy_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            manager=PluginManager(tmp)
            file=manager.directory/'settings.json'
            for raw,expected in [('5.6',6),('bad',300),('-1',5),('9000',7200)]:
                write_json(file,{'recallSeconds':raw,'recallEnabled':False})
                before=file.read_bytes();actual=manager.settings()
                self.assertEqual(actual['recallSeconds'],expected)
                self.assertFalse(actual['recallEnabled']);self.assertEqual(file.read_bytes(),before)


if __name__=='__main__':unittest.main()
