import hashlib
import tempfile
import unittest
from pathlib import Path
from koukou.image_cache import ImageCache, validate_index
from koukou.state import write_json


class CacheValidationTests(unittest.TestCase):
    def fixture(self):
        digest=lambda v:hashlib.sha256(v.encode()).hexdigest()
        return {'version':1,'images':[{'hash':digest('image'),'mime':'image/png','size':124,'usedAt':1720000000000,'aliases':[digest('qq-fileid')]}],
                'descriptions':[[digest('scope'),{'hashes':[digest('image')],'text':'通用图片描述','usedAt':1720000000000}]]}

    def test_js_compatible_cache_is_loaded_without_rewriting(self):
        with tempfile.TemporaryDirectory() as tmp:
            file=Path(tmp)/'index.json';write_json(file,self.fixture());before=file.read_bytes()
            cache=ImageCache(tmp)
            self.assertEqual(cache.stats()['images'],1)
            self.assertEqual(cache.stats()['descriptions'],1)
            self.assertEqual(file.read_bytes(),before)
            self.assertEqual(sorted(p.name for p in Path(tmp).iterdir()),['index.json'])

    def test_invalid_metadata_is_rejected_before_pruning_or_saving(self):
        invalid=[]
        for field,value in [('size',True),('size',-1),('size',2.5),('usedAt','bad'),('mime','text/html')]:
            entry=self.fixture();entry['images'][0][field]=value;invalid.append(entry)
        for value in ['bad',[123,{}],['0'*64,{'hashes':['path/escape'],'text':'x','usedAt':1}]]:
            entry=self.fixture();entry['descriptions']=[value];invalid.append(entry)
        for entry in invalid:
            with self.subTest(entry=entry),tempfile.TemporaryDirectory() as tmp:
                file=Path(tmp)/'index.json';write_json(file,entry);before=file.read_bytes()
                with self.assertRaises(ValueError):ImageCache(tmp)
                self.assertEqual(file.read_bytes(),before)
        entry=self.fixture();entry['images'][0]['usedAt']=float('inf')
        with self.assertRaises(ValueError):validate_index(entry)


if __name__=='__main__':unittest.main()
