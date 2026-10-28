"""Private-data migration checks use generic temporary fixtures, never live data."""
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from contextlib import redirect_stdout, redirect_stderr
from unittest.mock import patch

from koukou.migration_audit import audit_data


def save(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')


def snapshot(root):
    return {str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in root.rglob('*') if path.is_file()}


class MigrationAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.data = self.root/'data'
        self.data.mkdir()

    def tearDown(self):
        self.temp.cleanup()

    def fixture(self):
        private = 'PRIVATE-TEXT-NOT-FOR-REPORT'
        save(self.data/'memory.json', {'g123': [{'role': 'user', 'content': private, 'time': 1}]})
        save(self.data/'memory.json.reset.json', {'resetAt': 0, 'keyResetAt': {'g123': 0}})
        save(self.data/'long-memory.json', {'g123': {'summary': private, 'pending': [{'text': private, 'time': 1}], 'paused': True}})
        save(self.data/'long-memory.json.state.json', {'epoch': 'legacy', 'keyEpochs': {'g123': 'partition-1'}, 'clearedKeys': []})
        save(self.data/'memory__test-persona.json', {'chats': {'p456': []}, 'resetAt': 0, 'keyResetAt': {}})
        save(self.data/'long-memory__test-persona.json', {'chats': {}, 'epoch': 'legacy', 'keyEpochs': {}})
        save(self.data/'chat-settings.json', {'g123': {'persona': '示例人格', 'quietHours': None, 'proactiveRate': .2}})
        directory = self.data/'personas'
        directory.mkdir()
        (directory/'示例人格.txt').write_text(private, encoding='utf-8')
        save(self.data/'command-center.json', {'version': 1, 'builtins': {'summary': {'scope': 'group', 'groups': [123]}}})
        save(self.data/'custom-commands.json', [{'id': 'sample', 'trigger': '/sample', 'reply': private}])
        save(self.data/'vision-providers.json', [{'id': 'vp_sample', 'baseUrl': 'https://example.com/v1', 'apiKey': 'unit-test-secret-value'}])
        greeting = hashlib.sha256(private.encode()).hexdigest()
        save(self.data/'persona-greetings.json', {'version': 1, 'libraries': {greeting: {'goodmorning': ['早安'], 'goodnight': ['晚安']}}})
        image = b'\x89PNG\r\n\x1a\nfixture-content'
        digest = hashlib.sha256(image).hexdigest()
        sticker_dir = self.data/'stickers'
        sticker_dir.mkdir()
        owner = hashlib.sha256(json.dumps(['persona', '示例人格'], ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        save(sticker_dir/'persona-libraries.json', {'version': 1, 'legacyOwner': '示例人格', 'legacyKey': owner})
        save(sticker_dir/'stickers.json', [{'id': 'sample', 'name': private, 'hash': digest, 'file': digest[:16]+'.png', 'mime': 'image/png', 'size': len(image)}])
        (sticker_dir/(digest[:16]+'.png')).write_bytes(image)
        save(sticker_dir/'blacklist.json', [{'hash': 'a'*64, 'name': private}])
        save(sticker_dir/'learning-state.json', {'pausedByCapacity': False})
        archive = self.data/'long-memory.json.records'/'legacy'
        archive.mkdir(parents=True)
        (archive/('b'*64+'.jsonl')).write_text(json.dumps({'id': 'one', 'text': private, 'time': 1})+'\n', encoding='utf-8')
        daily = self.data/'daily'/'123'
        daily.mkdir(parents=True)
        (daily/'2026-01-01.jsonl').write_text(json.dumps({'id': 'one', 'userId': '456', 'name': private, 'text': private, 'time': 1})+'\n', encoding='utf-8')
        cache = self.data/'image-cache'
        cache.mkdir()
        save(cache/'index.json', {'images': [{'hash': digest, 'mime': 'image/png', 'size': len(image), 'usedAt': 1, 'aliases': []}],
                                  'descriptions': [['c'*64, {'hashes': [digest], 'text': private, 'usedAt': 1}]]})
        (cache/(digest+'.bin')).write_bytes(image)
        save(self.data/'native-action-delivery.json', {'opaque': {'status': 'uncertain'}})
        return private

    def test_js_formats_are_read_only_and_report_has_no_private_content(self):
        private = self.fixture()
        before = snapshot(self.root)
        with patch('koukou.state.write_json', side_effect=AssertionError('audit must not write')):
            result = audit_data(self.data)
        self.assertTrue(result['compatible'], result)
        self.assertFalse(result['ready'])
        self.assertEqual(result['counts']['recentChats'], 1)
        self.assertEqual(result['counts']['memoryPartitions'], 2)
        self.assertEqual(result['counts']['stickers'], 1)
        self.assertEqual(result['counts']['archiveRecords'], 1)
        self.assertEqual(result['counts']['dailyRecords'], 1)
        self.assertEqual(result['counts']['cachedImages'], 1)
        rendered = json.dumps(result, ensure_ascii=False)
        for value in [private, '示例人格', 'unit-test-secret-value', 'g123', str(self.root), 'https://example.com/v1']:
            self.assertNotIn(value, rendered)
        self.assertEqual(snapshot(self.root), before)
        self.assertEqual(result['fingerprint'], audit_data(self.data)['fingerprint'])

    def test_invalid_json_does_not_quarantine_or_overwrite_source(self):
        file = self.data/'memory.json'
        file.write_text('{malformed PRIVATE-TEXT', encoding='utf-8')
        before = snapshot(self.root)
        result = audit_data(self.data)
        self.assertFalse(result['compatible'])
        self.assertIn({'area': 'recent_memory', 'code': 'invalid_structure'}, result['errors'])
        self.assertEqual(snapshot(self.root), before)

    def test_reset_boundaries_and_pending_transactions_fail_closed(self):
        save(self.data/'memory.json.reset.json', {'resetAt': -1})
        save(self.data/'long-memory.json.state.json', {'resetPending': True})
        save(self.data/'session-transition.json', {'version': 1, 'phase': 'prepared'})
        result = audit_data(self.data)
        self.assertFalse(result['compatible'])
        self.assertIn({'area': 'pending_transaction', 'code': 'recovery_required'}, result['errors'])

    def test_missing_selected_persona_and_invalid_settings_are_reported_without_name(self):
        save(self.data/'chat-settings.json', {'g123': {'persona': 'MissingSensitivePersona'}})
        result = audit_data(self.data)
        self.assertIn({'area': 'personas', 'code': 'selected_persona_missing'}, result['errors'])
        self.assertNotIn('MissingSensitivePersona', json.dumps(result))
        save(self.data/'chat-settings.json', {'g123': {'quietHours': '29:00-07:00'}})
        self.assertFalse(audit_data(self.data)['compatible'])

    def test_sticker_path_traversal_is_not_opened(self):
        save(self.data/'stickers'/'stickers.json', [{'id': 'sample', 'hash': 'a'*64, 'file': '../outside.png'}])
        result = audit_data(self.data)
        self.assertFalse(result['compatible'])
        self.assertIn({'area': 'stickers', 'code': 'invalid_structure'}, result['errors'])
        self.assertEqual(result['counts']['files'], 1)

    def test_sticker_binary_hash_mime_and_capacity_are_checked(self):
        self.fixture()
        library = self.data/'stickers'/'stickers.json'
        items = json.loads(library.read_text(encoding='utf-8'))
        items[0]['hash'] = 'f'*64
        items[0]['mime'] = 'image/jpeg'
        save(library, items)
        result = audit_data(self.data)
        self.assertIn({'area': 'sticker_image', 'code': 'content_hash_or_mime_mismatch'}, result['errors'])
        save(library, items*61)
        self.assertIn({'area': 'stickers', 'code': 'capacity_exceeded'}, audit_data(self.data)['errors'])

    def test_symlink_is_not_followed_even_when_dangling(self):
        outside = self.root/'outside'
        outside.mkdir()
        try:
            (self.data/'memory.json').symlink_to(outside/'absent.json')
        except (OSError, NotImplementedError):
            self.skipTest('symlink creation unavailable')
        result = audit_data(self.data)
        self.assertIn({'area': 'recent_memory', 'code': 'linked_path'}, result['errors'])
        self.assertEqual(list(outside.iterdir()), [])

    def test_external_persona_requires_explicit_selected_directory(self):
        save(self.data/'chat-settings.json', {'g123': {'persona': 'Sample'}})
        external = self.root/'external'
        external.mkdir()
        (external/'Sample.txt').write_text('Generic persona', encoding='utf-8')
        env = self.root/'instance.env'
        env.write_text('ACTIVE_PERSONA=Sample\nPERSONA_DIR=external\nAPI_KEY=unit-test-secret-value\n', encoding='utf-8')
        self.assertFalse(audit_data(self.data, env_file=env)['compatible'])
        result = audit_data(self.data, env_file=env, persona_dir=external)
        self.assertTrue(result['compatible'], result)
        self.assertNotIn('unit-test-secret-value', json.dumps(result))

    def test_archives_validate_all_lines_without_skipping_bad_tail(self):
        self.fixture()
        file = self.data/'daily'/'123'/'2026-01-01.jsonl'
        file.write_text(file.read_text(encoding='utf-8')+'{bad tail\n', encoding='utf-8')
        before = snapshot(self.root)
        result = audit_data(self.data)
        self.assertIn({'area': 'daily_archive', 'code': 'invalid_jsonl_record'}, result['errors'])
        self.assertEqual(snapshot(self.root), before)

    def test_duplicate_keys_nonfinite_numbers_and_invalid_utf8_are_errors(self):
        for content in [b'{"g123":[],"g123":[]}', b'{"g123":[{"role":"user","content":"x","time":NaN}]}', b'\xff']:
            (self.data/'memory.json').write_bytes(content)
            self.assertFalse(audit_data(self.data)['compatible'])

    def test_missing_directory_is_not_created_and_empty_directory_is_not_cutover_ready(self):
        absent = self.root/'absent'
        result = audit_data(absent)
        self.assertFalse(result['compatible'])
        self.assertFalse(absent.exists())
        empty = audit_data(self.data)
        self.assertTrue(empty['compatible'])
        self.assertFalse(empty['ready'])
        self.assertIn({'area': 'data', 'code': 'no_recognized_data'}, empty['warnings'])

    def test_oversized_input_is_incomplete_instead_of_silently_truncated(self):
        save(self.data/'memory.json', {})
        file = self.data/'memory.json'
        with file.open('r+b') as stream:
            stream.truncate(32*1024*1024+1)
        result = audit_data(self.data)
        self.assertIn({'area': 'recent_memory', 'code': 'audit_size_limit'}, result['errors'])

    def test_manifest_matches_an_equivalent_copy_without_exposing_paths(self):
        self.fixture()
        clone = self.root/'clone'
        shutil.copytree(self.data, clone)
        self.assertEqual(audit_data(self.data)['fingerprint'], audit_data(clone)['fingerprint'])

    def test_live_change_prevents_compatibility_claim(self):
        save(self.data/'memory.json', {})
        original = Path.open
        class ConcurrentReader:
            def __init__(reader, path, *args, **kwargs):
                reader.file = original(path, *args, **kwargs)
                reader.path = path
            def __enter__(reader):
                return reader
            def __exit__(reader, *args):
                reader.file.close()
            def read(reader, size):
                data = reader.file.read(size)
                info = reader.path.stat()
                os.utime(reader.path, ns=(info.st_atime_ns, info.st_mtime_ns+1000000000))
                return data
        with patch.object(Path, 'open', lambda path, *args, **kwargs: ConcurrentReader(path, *args, **kwargs)):
            result = audit_data(self.data)
        self.assertFalse(result['compatible'])
        self.assertTrue(any(item['code'] == 'changed_during_audit' for item in result['errors']))

    def test_invalid_retry_state_cannot_appear_compatible_then_crash_worker(self):
        save(self.data/'long-memory.json', {'g123': {'summary': '', 'pending': [{'text': 'generic'}], 'retry': 'broken'}})
        self.assertIn({'area': 'long_memory', 'code': 'invalid_structure'}, audit_data(self.data)['errors'])

    def test_cli_does_not_construct_config_or_runtime_or_change_source(self):
        from koukou.__main__ import main
        self.fixture()
        before = snapshot(self.root)
        out, err = io.StringIO(), io.StringIO()
        with (patch('koukou.__main__.Config', side_effect=AssertionError('audit must not construct config')),
                patch('koukou.__main__.PluginManager', side_effect=AssertionError('audit must not construct plugins')),
                redirect_stdout(out), redirect_stderr(err)):
            code = main(['--root', str(self.root/'not-a-project'), 'audit-data', '--data-dir', str(self.data)])
        self.assertEqual(code, 0)
        self.assertTrue(json.loads(out.getvalue())['compatible'])
        self.assertFalse(json.loads(out.getvalue())['ready'])
        self.assertEqual(err.getvalue(), '')
        self.assertEqual(snapshot(self.root), before)

    def test_cli_real_process_utf8_source_env_and_error_exit(self):
        self.fixture()
        env = self.root/'sample.env'
        env.write_text('ACTIVE_PERSONA=示例人格\nAPI_KEY=unit-test-secret-value\n', encoding='utf-8')
        before = snapshot(self.root)
        command = [sys.executable, '-X', 'utf8', '-m', 'koukou', 'audit-data', '--data-dir', str(self.data), '--source-env', str(env)]
        process = subprocess.run(command, capture_output=True, encoding='utf-8', timeout=15)
        self.assertEqual(process.returncode, 0, process.stderr)
        self.assertTrue(json.loads(process.stdout)['compatible'])
        self.assertNotIn('unit-test-secret-value', process.stdout+process.stderr)
        self.assertEqual(snapshot(self.root), before)
        (self.data/'memory.json').write_text('{bad data', encoding='utf-8')
        process = subprocess.run(command, capture_output=True, encoding='utf-8', timeout=15)
        self.assertEqual(process.returncode, 1, process.stderr)
        self.assertFalse(json.loads(process.stdout)['compatible'])

    @unittest.skipUnless(shutil.which('node'), 'Node is needed only as the original JS data-format oracle')
    def test_original_js_writers_produce_accepted_read_only_data(self):
        destination = self.root/'js-data'
        destination.mkdir()
        script = Path(__file__).with_name('js_data_fixture.mjs')
        generated = subprocess.run(['node', str(script), str(destination)], capture_output=True, encoding='utf-8', timeout=15)
        self.assertEqual(generated.returncode, 0, generated.stderr)
        before = snapshot(destination)
        result = audit_data(destination)
        self.assertTrue(result['compatible'], result)
        self.assertEqual(result['counts']['memoryPartitions'], 2)
        self.assertEqual(result['counts']['stickers'], 1)
        self.assertEqual(result['counts']['cachedImages'], 1)
        self.assertEqual(result['counts']['archiveRecords'], 1)
        self.assertEqual(result['counts']['dailyRecords'], 1)
        self.assertEqual(snapshot(destination), before)

    def test_read_is_bounded_when_source_grows_after_stat(self):
        from koukou.migration_audit import _Audit
        save(self.data/'memory.json', {})
        audit = _Audit(self.data)
        with patch.object(Path, 'open', return_value=io.BytesIO(b'0123456789')):
            self.assertIsNone(audit.read(self.data/'memory.json', 'recent_memory', limit=4))
        result = audit.finish()
        self.assertIn({'area': 'recent_memory', 'code': 'audit_size_limit'}, result['errors'])
        self.assertIn({'area': 'recent_memory', 'code': 'changed_during_audit'}, result['errors'])
        self.assertEqual((self.data/'memory.json').read_text(encoding='utf-8'), '{}')

    def test_windows_reparse_attribute_is_rejected_without_symlink_privileges(self):
        original = Path.lstat
        def attributes(path):
            info = original(path)
            return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400) if path == self.data else info
        with patch.object(Path, 'lstat', attributes):
            result = audit_data(self.data)
        self.assertIn({'area': 'data', 'code': 'linked_path'}, result['errors'])
        self.assertFalse(result['compatible'])


if __name__ == '__main__':
    unittest.main()
