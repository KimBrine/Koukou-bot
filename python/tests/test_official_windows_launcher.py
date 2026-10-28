"""Windows desktop startup recovery; fixtures never use a real bot profile."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


@unittest.skipUnless(sys.platform == 'win32', 'Windows desktop launcher')
class OfficialWindowsLauncherTests(unittest.TestCase):
    def setUp(self):
        source = Path(__file__).resolve().parents[2] / 'integrations/qq-official-bridge/windows/launcher.py'
        spec = importlib.util.spec_from_file_location('official_desktop_launcher', source)
        self.launcher = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.launcher)
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.launcher.PROFILE = Path(self.temp.name)
        self.lock = self.launcher.PROFILE / 'bridge/state/.bridge.lock'
        self.lock.parent.mkdir(parents=True)
        self.record = {'protocol':'koukou-qq-official-v1','pid':123456,'token':'test-only-token'}

    def write(self, value=None):
        self.lock.write_text(json.dumps(self.record if value is None else value), encoding='utf-8')

    def test_missing_lock_is_noop(self):
        self.assertFalse(self.launcher.recover_bridge_lock())

    def test_dead_bridge_lock_is_archived_without_touching_other_files(self):
        self.write()
        original = self.lock.read_bytes()
        credentials = self.lock.parent.parent / 'credentials.json'
        credentials.write_text('fixture-credentials-do-not-modify', encoding='utf-8')
        with patch.object(self.launcher, 'process_state', return_value='dead'):
            self.assertTrue(self.launcher.recover_bridge_lock())
        self.assertFalse(self.lock.exists())
        archived = list(self.lock.parent.glob('.bridge.lock.stale-*'))
        self.assertEqual(len(archived), 1)
        self.assertEqual(archived[0].read_bytes(), original)
        self.assertEqual(credentials.read_text(), 'fixture-credentials-do-not-modify')

    def test_live_or_unverifiable_process_is_never_recovered(self):
        for state in ('alive', 'unknown'):
            self.write()
            with patch.object(self.launcher, 'process_state', return_value=state), self.assertRaises(RuntimeError):
                self.launcher.recover_bridge_lock()
            self.assertTrue(self.lock.is_file())

    def test_malformed_and_foreign_locks_are_never_changed(self):
        for value in ([], {}, {**self.record,'pid':True}, {**self.record,'protocol':'foreign'}):
            self.write(value)
            before = self.lock.read_bytes()
            with self.assertRaises(RuntimeError):
                self.launcher.recover_bridge_lock()
            self.assertEqual(self.lock.read_bytes(), before)

    def test_changed_lock_is_never_archived(self):
        self.write()
        newer = {**self.record, 'pid':654321,'token':'new-test-token'}
        def changed(_):
            self.write(newer)
            return 'dead'
        with patch.object(self.launcher,'process_state',side_effect=changed), self.assertRaises(RuntimeError):
            self.launcher.recover_bridge_lock()
        self.assertEqual(json.loads(self.lock.read_text()), newer)

    def test_actual_windows_process_probe_distinguishes_running_and_exited(self):
        self.assertEqual(self.launcher.process_state(os.getpid()), 'alive')
        child = subprocess.Popen([sys.executable, '-c', 'pass'], creationflags=subprocess.CREATE_NO_WINDOW)
        child.wait(timeout=10)
        self.assertEqual(self.launcher.process_state(child.pid), 'dead')
