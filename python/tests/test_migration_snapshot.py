"""Snapshot/rehearsal acceptance only touches generic TemporaryDirectory fixtures."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

import koukou.migration_snapshot as snapshots


def contents(root):
    return {path.relative_to(root).as_posix(): (path.read_bytes(), path.stat().st_mtime_ns)
            for path in root.rglob('*') if path.is_file()}


class MigrationSnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root/'instance'
        self.source.mkdir()
        for name, body in {
            'memory.json': '{"g123":[]}', 'long-memory.json': '{}',
            'daily/123/2026-01-01.jsonl': '{"text":"generic archived record","time":1}\n',
            'personas/Sample.txt': 'Generic persona',
            'config-backups/sample.json': '{"generic":"private archival fixture"}',
            'backups/sample/unknown.bin': 'nested backup payload',
            'native-action-delivery.json': '{"sample":{"status":"uncertain"}}',
            'unknown-future-format.dat': 'unknown state must not be silently omitted',
        }.items():
            file = self.source/name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(body, encoding='utf-8')
        (self.source/'empty-directory').mkdir()
        self.destination = self.root/'snapshot'

    def tearDown(self):
        self.temp.cleanup()

    def test_complete_snapshot_verifies_all_data_and_derives_identical_rehearsal(self):
        before = contents(self.source)
        result = snapshots.create_snapshot(self.source, self.destination)
        self.assertTrue(result['ok'], result)
        self.assertFalse(result['ready'])
        self.assertFalse(result['stoppedInstanceVerified'])
        self.assertEqual(result['counts']['files'], len(before))
        self.assertEqual(contents(self.source), before)
        self.assertEqual({key: value[0] for key, value in contents(self.destination/'data').items()},
                         {key: value[0] for key, value in before.items()})
        self.assertTrue((self.destination/'data'/'empty-directory').is_dir())
        verified = snapshots.verify_snapshot(self.destination)
        self.assertTrue(verified['ok'], verified)
        self.assertEqual(verified['fingerprint'], result['fingerprint'])
        rehearsal = self.root/'rehearsal'
        derived = snapshots.derive_rehearsal(self.destination, rehearsal)
        self.assertTrue(derived['ok'], derived)
        self.assertEqual(derived['fingerprint'], result['fingerprint'])
        self.assertEqual(snapshots.verify_snapshot(rehearsal)['fingerprint'], result['fingerprint'])
        self.assertEqual(contents(self.source), before)

    def test_exclusions_are_explicit_and_exact_scope_is_in_private_manifest(self):
        (self.source/'bot.lock').write_text('runtime lock', encoding='utf-8')
        (self.source/'temp').mkdir()
        (self.source/'temp'/'part.bin').write_bytes(b'temporary payload')
        result = snapshots.create_snapshot(self.source, self.destination, exclude=['bot.lock', 'temp'])
        self.assertTrue(result['ok'], result)
        manifest = json.loads((self.destination/'snapshot.json').read_text(encoding='utf-8'))
        self.assertEqual(manifest['scope']['excluded'], ['bot.lock', 'temp'])
        self.assertFalse((self.destination/'data'/'bot.lock').exists())
        self.assertFalse((self.destination/'data'/'temp').exists())
        self.assertEqual(result['scope']['exclusionCount'], 2)
        self.assertTrue((self.source/'bot.lock').exists())

    def test_no_implicit_exclusions_and_env_is_explicit_archival_copy_only(self):
        (self.source/'bot.lock').write_text('generic', encoding='utf-8')
        env = self.root/'private.env'
        env.write_text('API_KEY=fixture-only-key\nBOT_DATA_DIR=do-not-activate\n', encoding='utf-8')
        before = env.read_bytes()
        result = snapshots.create_snapshot(self.source, self.destination, env_file=env)
        self.assertTrue(result['ok'], result)
        self.assertTrue((self.destination/'data'/'bot.lock').exists())
        self.assertEqual((self.destination/'config'/'source.env.backup').read_bytes(), before)
        self.assertEqual(env.read_bytes(), before)
        self.assertTrue(result['scope']['explicitEnvCopy'])
        self.assertFalse((self.destination/'.env').exists())
        rehearsal = self.root/'rehearsal'
        self.assertTrue(snapshots.derive_rehearsal(self.destination, rehearsal)['ok'])
        self.assertEqual((rehearsal/'config'/'source.env.backup').read_bytes(), before)
        self.assertFalse((rehearsal/'.env').exists())
        self.assertFalse((rehearsal/'data'/'.env').exists())
        for private in ['fixture-only-key', 'do-not-activate', str(self.root), 'private archival fixture', 'Sample.txt', 'g123']:
            self.assertNotIn(private, json.dumps(result))

    def test_existing_destination_including_running_instance_is_never_overwritten(self):
        self.destination.mkdir()
        marker = self.destination/'bot.lock'
        marker.write_text('active instance', encoding='utf-8')
        before = contents(self.destination)
        result = snapshots.create_snapshot(self.source, self.destination)
        self.assertEqual(result['status'], 'refused')
        self.assertIn('destination_must_be_new', result['errors'])
        self.assertEqual(contents(self.destination), before)

    def test_destination_inside_source_is_refused_without_creating_it(self):
        target = self.source/'nested-target'
        result = snapshots.create_snapshot(self.source, target)
        self.assertIn('destination_overlaps_source', result['errors'])
        self.assertFalse(target.exists())

    def test_source_change_during_copy_leaves_explicit_incomplete_copy(self):
        original = snapshots._read_file
        changed = False
        def read(path, **kwargs):
            nonlocal changed
            result = original(path, **kwargs)
            if kwargs.get('target') is not None and not changed:
                (self.source/'memory.json').write_text('{"changed":true}', encoding='utf-8')
                changed = True
            return result
        with patch.object(snapshots, '_read_file', read):
            result = snapshots.create_snapshot(self.source, self.destination)
        self.assertFalse(result['ok'])
        self.assertEqual(result['status'], 'incomplete')
        self.assertEqual(json.loads((self.destination/'snapshot.json').read_text(encoding='utf-8'))['status'], 'incomplete')
        self.assertFalse(snapshots.verify_snapshot(self.destination)['ok'])
        self.assertTrue(self.source.is_dir())

    def test_source_file_collection_change_is_detected(self):
        original = snapshots._inventory
        calls = 0
        def inventory(path, *args):
            nonlocal calls
            calls += 1
            if calls == 2:
                (self.source/'new-event.json').write_text('{}', encoding='utf-8')
            return original(path, *args)
        with patch.object(snapshots, '_inventory', inventory):
            result = snapshots.create_snapshot(self.source, self.destination)
        self.assertFalse(result['ok'])
        self.assertIn('source_changed', result['errors'])

    def test_corrupt_or_extra_snapshot_payload_prevents_rehearsal(self):
        self.assertTrue(snapshots.create_snapshot(self.source, self.destination)['ok'])
        (self.destination/'data'/'memory.json').write_text('tampered', encoding='utf-8')
        rehearsal = self.root/'rehearsal'
        result = snapshots.derive_rehearsal(self.destination, rehearsal)
        self.assertFalse(result['ok'])
        self.assertIn('snapshot_payload_mismatch', result['errors'])
        self.assertFalse(rehearsal.exists())

    def test_unlisted_snapshot_file_is_not_silently_ignored(self):
        self.assertTrue(snapshots.create_snapshot(self.source, self.destination)['ok'])
        (self.destination/'extra.txt').write_text('unlisted', encoding='utf-8')
        self.assertIn('snapshot_payload_mismatch', snapshots.verify_snapshot(self.destination)['errors'])

    def test_manifest_paths_cannot_escape_or_use_windows_alternate_streams(self):
        self.assertTrue(snapshots.create_snapshot(self.source, self.destination)['ok'])
        file = self.destination/'snapshot.json'
        original = json.loads(file.read_text(encoding='utf-8'))
        for bad in ['../outside', 'data/../outside', 'data/x:stream', '/absolute', 'data/CON.txt', 'data\\outside']:
            manifest = dict(original)
            manifest['files'] = {bad: {'size': 0, 'sha256': 'a'*64}}
            file.write_text(json.dumps(manifest), encoding='utf-8')
            self.assertFalse(snapshots.verify_snapshot(self.destination)['ok'])

    def test_rehearsal_never_recreates_original_source_even_if_source_was_removed(self):
        self.assertTrue(snapshots.create_snapshot(self.source, self.destination)['ok'])
        self.assertTrue(self.source.resolve().is_relative_to(self.root.resolve()))
        shutil.rmtree(self.source)
        result = snapshots.derive_rehearsal(self.destination, self.source)
        self.assertIn('destination_is_protected_source', result['errors'])
        self.assertFalse(self.source.exists())

    def test_rehearsal_cannot_write_inside_original_source_instance(self):
        self.assertTrue(snapshots.create_snapshot(self.source, self.destination)['ok'])
        target = self.source/'new-rehearsal'
        before = contents(self.source)
        result = snapshots.derive_rehearsal(self.destination, target)
        self.assertIn('destination_is_protected_source', result['errors'])
        self.assertFalse(target.exists())
        self.assertEqual(contents(self.source), before)

    def test_partial_io_failure_keeps_incomplete_and_does_not_delete_source(self):
        before = contents(self.source)
        original = snapshots._read_file
        def failure(path, **kwargs):
            if kwargs.get('target') is not None:
                raise OSError('fixture-private-os-error')
            return original(path, **kwargs)
        with patch.object(snapshots, '_read_file', failure):
            result = snapshots.create_snapshot(self.source, self.destination)
        self.assertFalse(result['ok'])
        self.assertEqual(result['status'], 'incomplete')
        self.assertNotIn('fixture-private-os-error', json.dumps(result))
        self.assertEqual(contents(self.source), before)
        self.assertEqual(json.loads((self.destination/'snapshot.json').read_text(encoding='utf-8'))['status'], 'incomplete')

    def test_symlink_in_source_or_destination_ancestors_is_refused(self):
        outside = self.root/'outside'
        outside.mkdir()
        try:
            (self.source/'linked').symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('symlink creation unavailable')
        before = contents(outside)
        result = snapshots.create_snapshot(self.source, self.destination)
        self.assertIn('linked_or_reparse_path', result['errors'])
        self.assertEqual(contents(outside), before)

    def test_windows_reparse_path_is_rejected_without_elevated_test_privileges(self):
        original = Path.lstat
        def attributes(path):
            info = original(path)
            return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400) if path == self.source else info
        with patch.object(Path, 'lstat', attributes):
            result = snapshots.create_snapshot(self.source, self.destination)
        self.assertFalse(result['ok'])
        self.assertIn('linked_or_reparse_path', result['errors'])
        self.assertFalse(self.destination.exists())

    def test_destination_parent_reparse_is_rejected_before_creation(self):
        original = Path.lstat
        parent = self.root/'alias-parent'
        parent.mkdir()
        def attributes(path):
            info = original(path)
            return SimpleNamespace(st_mode=info.st_mode, st_file_attributes=0x400) if path == parent else info
        with patch.object(Path, 'lstat', attributes):
            result = snapshots.create_snapshot(self.source, parent/'copy')
        self.assertFalse(result['ok'])
        self.assertIn('linked_or_reparse_path', result['errors'])
        self.assertFalse((parent/'copy').exists())

    def test_rehearsal_source_change_or_incomplete_manifest_is_refused(self):
        self.assertTrue(snapshots.create_snapshot(self.source, self.destination)['ok'])
        file = self.destination/'snapshot.json'
        value = json.loads(file.read_text(encoding='utf-8'))
        value['status'] = 'incomplete'
        file.write_text(json.dumps(value), encoding='utf-8')
        target = self.root/'rehearsal'
        self.assertFalse(snapshots.derive_rehearsal(self.destination, target)['ok'])
        self.assertFalse(target.exists())

    def test_invalid_exclusions_cannot_escape_source_or_become_globs(self):
        for excluded in ['../outside', '/absolute', '**', 'daily/../memory.json', 'temp\\*']:
            result = snapshots.create_snapshot(self.source, self.destination, exclude=[excluded])
            self.assertFalse(result['ok'])
            self.assertFalse(self.destination.exists())

    def test_real_cli_subprocess_workflow_never_constructs_services_or_reuses_targets(self):
        # Execute the real CLI parser/entry in separate interpreters, with traps
        # proving all three paths return before mutable Config/plugin creation.
        runner = """import sys
import koukou.__main__ as entry
def forbidden(*args, **kwargs):
    raise AssertionError('snapshot CLI must not construct runtime services')
entry.Config = forbidden
entry.PluginManager = forbidden
raise SystemExit(entry.main())
"""
        env = {**os.environ, 'PYTHONPATH': str(Path(snapshots.__file__).resolve().parents[1])}
        source_env = self.root/'archival.env'
        source_env.write_text('API_KEY=fixture-private-key\nBOT_DATA_DIR=do-not-activate\n', encoding='utf-8')
        # An implicit current-directory configuration read would fail even
        # without the explicit constructor traps above.
        (self.root/'.env').write_bytes(b'\xff invalid implicit configuration')
        (self.source/'bot.lock').write_text('source lock remains untouched', encoding='utf-8')
        source_before, env_before = contents(self.source), source_env.read_bytes()
        def cli(*arguments, expected=0):
            process = subprocess.run([sys.executable, '-X', 'utf8', '-c', runner, *map(str, arguments)],
                cwd=self.root, env=env, capture_output=True, encoding='utf-8', timeout=15)
            self.assertEqual(process.returncode, expected, process.stderr)
            self.assertEqual(process.stderr, '')
            self.assertNotIn('fixture-private-key', process.stdout)
            self.assertNotIn('do-not-activate', process.stdout)
            return json.loads(process.stdout)
        created = cli('snapshot-data', '--data-dir', self.source, '--destination', self.destination,
            '--source-env', source_env, '--exclude', 'bot.lock')
        self.assertTrue(created['ok'])
        self.assertFalse(created['ready'])
        snapshot_before = contents(self.destination)
        verified = cli('verify-snapshot', '--snapshot', self.destination)
        self.assertEqual(verified['fingerprint'], created['fingerprint'])
        self.assertEqual(contents(self.destination), snapshot_before)
        rehearsal = self.root/'cli-rehearsal'
        derived = cli('rehearse-restore', '--snapshot', self.destination, '--destination', rehearsal)
        self.assertEqual(derived['fingerprint'], created['fingerprint'])
        self.assertEqual((rehearsal/'config'/'source.env.backup').read_bytes(), env_before)
        self.assertFalse((rehearsal/'.env').exists())
        self.assertFalse((rehearsal/'data'/'bot.lock').exists())
        rehearsal_before = contents(rehearsal)
        refused = cli('snapshot-data', '--data-dir', self.source, '--destination', self.destination, expected=1)
        self.assertIn('destination_must_be_new', refused['errors'])
        self.assertEqual(contents(self.destination), snapshot_before)
        refused = cli('rehearse-restore', '--snapshot', self.destination, '--destination', rehearsal, expected=1)
        self.assertIn('destination_must_be_new', refused['errors'])
        self.assertEqual(contents(rehearsal), rehearsal_before)
        self.assertEqual(contents(self.source), source_before)
        self.assertEqual(source_env.read_bytes(), env_before)


if __name__ == '__main__':
    unittest.main()
