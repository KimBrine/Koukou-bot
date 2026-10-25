"""Grounded visual evidence, private paths and real optional Pillow fingerprints."""
import asyncio
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
from koukou.config import Config
from koukou.image_hash import ImageHasher, Image, distance
from koukou.state import write_json
from koukou.vision import (GroundedVisionClient, load_vision_knowledge, read_local_profile,
    parse_visual_comparison, sanitize_image_description, strip_report_scaffold,
    with_image_content, build_image_context_note, looks_like_report, pick_image_fallback)


def url(data):
    return 'data:image/png;base64,'+base64.b64encode(data).decode()


def image_data(reverse=False, color=0, animated=False):
    if Image is None:
        raise unittest.SkipTest('Pillow optional dependency is not installed')
    image = Image.new('RGB', (9,8))
    image.putdata([(255-x*25 if reverse else x*25, color, color) for y in range(8) for x in range(9)])
    stream = io.BytesIO()
    if animated:
        image.save(stream, 'GIF', save_all=True, append_images=[Image.new('RGB', image.size, 'white')], duration=50)
    else:
        image.save(stream, 'PNG')
    return stream.getvalue()


def comparison(name='Azure', evidence=None, description='Azure戴着帽子', image=1, confidence='high'):
    return json.dumps({'description':description,'identities':[{'image':image,'name':name,'confidence':confidence,
        'evidence':['可见的帽檐','衣领的花纹'] if evidence is None else evidence}]}, ensure_ascii=False)


class VisualNoteTests(unittest.TestCase):
    def test_notes_strip_scaffolding_without_mutating_question_evidence(self):
        text = '# 标题\n1. **主体**\n2. 第二项\n```py\nx=1\n```'
        ordinary = sanitize_image_description(text)
        self.assertEqual(ordinary, '标题 主体 第二项')
        self.assertEqual(sanitize_image_description('甲'*170), '甲'*160+'…')
        self.assertEqual(sanitize_image_description(text, long_mode=True), text)
        self.assertEqual(strip_report_scaffold(text, long_mode=True), text)
        self.assertEqual(strip_report_scaffold('### 标题\n下一行'), '标题\n下一行')
        self.assertTrue(looks_like_report('以下是对群聊的详细解读'))
        self.assertFalse(looks_like_report('这个表情真可爱'))
        self.assertEqual(with_image_content('看[图片]和[图片]', '客观内容'), '看[图片内容：客观内容]和[图片内容：客观内容]')
        self.assertIn('附带图片', with_image_content('看', '内容'))
        self.assertIn('完整使用题目条件', build_image_context_note('题目', question_mode=True))
        self.assertEqual(pick_image_fallback(lambda:.99, ['a','b']), 'b')


class PrivateVisionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.directory = self.root/'vision-knowledge'
        self.directory.mkdir()
        # Valid signatures suffice for reference loading; decoding belongs to the model.
        self.png1, self.png2 = b'\x89PNG\r\n\x1a\n' + b'a'*100, b'\x89PNG\r\n\x1a\n'+b'b'*100
        (self.directory/'first.png').write_bytes(self.png1)
        (self.directory/'second.png').write_bytes(self.png2)
        self.value = {'characters':[{'name':'Azure','aliases':['Azu']},{'name':'Amber','aliases':[]}],
            'references':[{'name':'Azure','file':'first.png'},{'name':'Amber','file':'second.png'}],
            'prompt':'辨认只用可见的服饰和配件，不猜测。','cues':['帽子']}
        write_json(self.directory/'rules.json', self.value)

    def tearDown(self):
        self.temp.cleanup()

    def test_private_profile_missing_filtering_limits_and_no_example_fallback(self):
        (self.root/'examples').mkdir()
        write_json(self.root/'examples'/'profile.local.json', {'conversationRules':'never load examples'})
        self.assertEqual(read_local_profile(self.root), {})
        value = {'conversationRules':'private instance style','idCheckReminder':'甲'*1700,
            'imageFallbackReplies':['', 'hello', 123], 'unknown':'ignored',
            'decoration':{'symbol':'✨','kaomoji':['(^_^)'], 'weights':{'emoji':1.7,'kaomoji':-1,'both':'bad'}}}
        write_json(self.root/'profile.local.json', value)
        profile = read_local_profile(self.root)
        self.assertEqual(len(profile['idCheckReminder']), 1600)
        self.assertEqual(profile['imageFallbackReplies'], ['hello'])
        self.assertEqual(profile['decoration']['weights'], {'emoji':1,'kaomoji':0,'both':0})
        self.assertNotIn('unknown', profile)
        (self.root/'profile.local.json').write_text('{"decoration":NaN}', encoding='utf-8')
        with self.assertRaises(ValueError): read_local_profile(self.root)

    def test_knowledge_scope_changes_with_rules_or_reference_bytes(self):
        first = load_vision_knowledge(self.root)
        self.assertEqual(first['references'][0]['part']['image_url']['url'], url(self.png1))
        expected = hashlib.sha256((self.directory/'rules.json').read_bytes()+url(self.png1).encode()+url(self.png2).encode()).hexdigest()
        self.assertEqual(first['version'], expected)
        (self.directory/'first.png').write_bytes(self.png1+b'changed')
        second = load_vision_knowledge(self.root)
        self.assertNotEqual(first['version'], second['version'])
        self.value['prompt'] += '新的区分特征'
        write_json(self.directory/'rules.json', self.value)
        third = load_vision_knowledge(self.root)
        self.assertNotEqual(second['version'], third['version'])

    def test_invalid_paths_and_mime_cannot_load_private_files(self):
        for file in ['../private.png', '/private.png', 'sub/file.png', 'other.exe']:
            self.value['references'][0]['file'] = file
            write_json(self.directory/'rules.json', self.value)
            self.assertIsNone(load_vision_knowledge(self.root))
        self.value['references'][0]['file'] = 'first.png'
        write_json(self.directory/'rules.json', self.value)
        (self.directory/'first.png').write_bytes(b'not an image')
        self.assertIsNone(load_vision_knowledge(self.root))

    def test_symlink_reference_is_rejected(self):
        outside = self.root/'private.png'; outside.write_bytes(self.png1)
        link = self.directory/'linked.png'
        try:
            link.symlink_to(outside)
        except OSError:
            self.skipTest('Symlink creation is unavailable in this environment')
        self.value['references'][0]['file'] = link.name
        write_json(self.directory/'rules.json', self.value)
        self.assertIsNone(load_vision_knowledge(self.root))

    def test_comparison_requires_independent_evidence_for_every_image(self):
        knowledge = load_vision_knowledge(self.root)
        self.assertEqual(parse_visual_comparison(comparison(), knowledge, 1), '【角色已确认：Azure】该角色戴着帽子')
        self.assertEqual(parse_visual_comparison(comparison(evidence=['唯一特征','唯一特征']), knowledge, 1), '【角色身份未确认】该角色戴着帽子')
        self.assertIsNone(parse_visual_comparison(comparison(image=True), knowledge, 1))
        self.assertIsNone(parse_visual_comparison(comparison(), knowledge, 2))
        long = '图表里的详细条件。'*1000
        ordinary = parse_visual_comparison(comparison(description=long), knowledge, 1)
        full = parse_visual_comparison(comparison(description=long), knowledge, 1, long_mode=True)
        self.assertEqual(len(ordinary.split('】')[1]), 500)
        self.assertTrue(full.endswith(long))


class GroundedClientTests(PrivateVisionTests, unittest.IsolatedAsyncioTestCase):
    async def test_manual_annotation_never_calls_model(self):
        hash = hashlib.sha256(self.png1).hexdigest()
        self.value['exact'] = {hash:{'name':'Azure','description':'人工确认的画面'}}
        write_json(self.directory/'rules.json', self.value)
        client = type('Client', (), {'describe':AsyncMock()})()
        grounded = GroundedVisionClient(client, load_vision_knowledge(self.root))
        self.assertEqual(await grounded.describe('read','ask',[url(self.png1)]), '【角色已确认：Azure】人工确认的画面')
        self.assertEqual(client.describe.await_count, 0)

    async def test_two_stage_objective_comparison_keeps_labels_and_full_question(self):
        text = '条件'+('长条件。'*1000)
        client = type('Client', (), {'model':'vision', 'base_url':'https://vision.invalid',
            'describe':AsyncMock(side_effect=['Azure戴着帽子', comparison(description=text)])})()
        grounded = GroundedVisionClient(client, load_vision_knowledge(self.root))
        result = await grounded.describe('objective','ask',[url(self.png1)], long_mode=True, unlimited=True)
        self.assertTrue(result.endswith(text))
        self.assertEqual(client.describe.await_count, 2)
        comparison_call = client.describe.await_args
        self.assertEqual(len(comparison_call.args[2]), 3)
        self.assertIn('输入第3张是本次待识别第1张', comparison_call.args[1])
        self.assertTrue(comparison_call.kwargs['unlimited'])
        self.assertNotIn('max_tokens', comparison_call.kwargs)
        self.assertNotEqual(grounded.cache_scope(long_mode=True), grounded.cache_scope())

    async def test_unrelated_picture_does_not_compare_and_stale_output_is_discarded(self):
        client = type('Client', (), {'describe':AsyncMock(return_value='一张山水画')})()
        grounded = GroundedVisionClient(client, load_vision_knowledge(self.root))
        self.assertEqual(await grounded.describe('read','ask',[url(self.png1)]), '一张山水画')
        self.assertEqual(client.describe.await_count, 1)
        active = True
        async def changed(*args, **kwargs):
            nonlocal active
            active = False; return 'Azure'
        client.describe = AsyncMock(side_effect=changed)
        with self.assertRaisesRegex(ValueError, '失效'):
            await grounded.describe('read','ask',[url(self.png1)], current=lambda:active)

    async def test_failed_comparison_hides_names_and_guard_allows_only_corrections(self):
        client = type('Client', (), {'describe':AsyncMock(side_effect=['Azure和Azu都在画面中', OSError('temporary')])})()
        grounded = GroundedVisionClient(client, load_vision_knowledge(self.root))
        result = await grounded.describe('read','ask',[url(self.png1)])
        self.assertEqual(result, '【角色身份未确认】该角色和该角色都在画面中')
        self.assertEqual(grounded.guard_reply('这不是Azure。', result), '这不是Azure。')
        self.assertEqual(grounded.guard_reply('不就是Azure吗', result), '这张我还没认准角色，先不乱猜啦')
        self.assertEqual(grounded.guard_reply('这是Amber', '【角色已确认：Azure】帽子'), '这是Azure呀')

    async def test_snapshot_pins_knowledge_and_new_reads_get_new_cache_scope(self):
        client = type('Client', (), {'model':'vision','base_url':'https://vision.invalid','describe':AsyncMock(return_value='山水')})()
        live = GroundedVisionClient(client, data_dir=self.root)
        first = live.snapshot()
        before = first.cache_scope()
        (self.directory/'first.png').write_bytes(self.png1+b'updated')
        self.assertEqual(before, first.cache_scope())
        self.assertNotEqual(before, live.snapshot().cache_scope())


class FingerprintTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.config = Config(self.root, environ={})
        self.directory = self.config.data_dir/'stickers'
        self.directory.mkdir(parents=True)

    async def asyncTearDown(self):
        self.temp.cleanup()

    async def test_unsupported_is_explicit_and_produces_no_fingerprint(self):
        hasher = ImageHasher(self.config, pillow=False)
        self.assertFalse(hasher.supported)
        self.assertIsNone(hasher.hash_data(b'not an image'))
        self.assertFalse(await hasher.hash_files([self.root/'outside.png']))
        self.assertFalse((self.config.data_dir/'sticker-hashes.json').exists())
        result = await hasher.detect_similar(type('Store', (), {})())
        self.assertFalse(result['supported'])
        self.assertEqual(result['groups'], [])

    @unittest.skipIf(Image is None, 'Pillow optional dependency is not installed')
    async def test_real_dhash_direction_animation_distance_and_size_guards(self):
        hasher = ImageHasher(self.config)
        self.assertEqual(hasher.hash_data(image_data()), '1'*64)
        self.assertEqual(hasher.hash_data(image_data(True)), '0'*64)
        self.assertEqual(hasher.hash_data(image_data(animated=True)), '1'*64)
        self.assertEqual(distance('1'*64, '1'*56+'0'*8), 8)
        self.assertEqual(distance('short','short'), 64)
        with self.assertRaises(ValueError): hasher.hash_data(b'\x89PNG\r\n\x1a\nnot valid')
        hasher.max_pixels = 10
        with self.assertRaisesRegex(ValueError, '尺寸'): hasher.hash_data(image_data())

    @unittest.skipIf(Image is None, 'Pillow optional dependency is not installed')
    async def test_legacy_cache_recomputed_and_replacement_invalidates_cached_rows(self):
        path = self.directory/'one.png'; path.write_bytes(image_data())
        write_json(self.config.data_dir/'sticker-hashes.json', {str(path):{'hash':'0'*64,'mtime':path.stat().st_mtime*1000,'size':path.stat().st_size}})
        hasher = ImageHasher(self.config)
        self.assertIsNone(hasher.hash_of({'file':'one.png'}, self.directory))
        await hasher.hash_files([path])
        self.assertEqual(hasher.hash_of({'file':'one.png'}, self.directory), '1'*64)
        self.assertIn('pillow-dhash64', hasher.cache[str(path)]['algorithm'])
        path.write_bytes(image_data(True))
        self.assertIsNone(hasher.hash_of({'file':'one.png'}, self.directory))
        await hasher.hash_files([path])
        self.assertEqual(hasher.hash_of({'file':'one.png'}, self.directory), '0'*64)
        hasher.forget(path)
        self.assertIsNone(hasher.hash_of({'file':'one.png'}, self.directory))
        with self.assertRaisesRegex(ValueError, '本实例'): await hasher.hash_files([self.root/'outside.png'])

    @unittest.skipIf(Image is None, 'Pillow optional dependency is not installed')
    async def test_detect_similar_threshold_scope_and_learner_integration(self):
        items = [{'id':'one','name':'first','file':'one.png'},{'id':'two','name':'same','file':'two.png'},{'id':'three','name':'reverse','file':'three.png'}]
        for name, data in [('one.png',image_data()),('two.png',image_data(color=30)),('three.png',image_data(True))]:
            (self.directory/name).write_bytes(data)
        store = type('Store', (), {'dir':self.directory,'list':lambda s:items})()
        hasher = ImageHasher(self.config)
        result = await hasher.detect_similar(store)
        self.assertEqual(result, {'checked':3,'groups':[{'distance':0,'a':{'id':'one','name':'first'},'b':{'id':'two','name':'same'}}]})
        self.assertTrue(await hasher.similar(url(image_data()), {'store':store,'current':lambda:True}))
        self.assertFalse(await hasher.similar(url(image_data()), {'store':store,'current':lambda:False}))
        with self.assertRaisesRegex(ValueError, '范围已变化'):
            await hasher.detect_similar(store, current=lambda:False)


if __name__ == '__main__':
    unittest.main()
