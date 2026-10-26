import os
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from koukou import resources
from koukou.plugins import PluginManager
from koukou.updates import local_version


class ResourceTests(unittest.TestCase):
    def test_source_resources_do_not_depend_on_working_directory(self):
        previous = Path.cwd()
        with tempfile.TemporaryDirectory() as directory:
            try:
                os.chdir(directory)
                self.assertEqual(resources.default_instance_root(environ={}), resources.development_root())
                for name in resources.FRONTEND_FILES:
                    self.assertTrue((resources.frontend_assets(directory) / name).is_file())
                self.assertTrue(resources.migration_contract(directory).is_file())
            finally:
                os.chdir(previous)

    def test_installed_default_is_stable_writable_and_not_cwd_or_package(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(resources, 'development_root', return_value=None):
            home = Path(directory).resolve()
            for platform in ('win32', 'darwin', 'linux'):
                selected = resources.default_instance_root(environ={}, platform=platform, home=home)
                self.assertTrue(selected.is_relative_to(home))
                self.assertNotEqual(selected, Path.cwd())
                self.assertFalse(selected.exists())
            explicit = home / 'isolated'
            self.assertEqual(resources.default_instance_root(environ={'KOUKOU_INSTANCE_DIR':str(explicit)}), explicit)
            with self.assertRaises(ValueError):
                resources.default_instance_root(environ={'KOUKOU_INSTANCE_DIR':'relative-instance'})

    def test_explicit_builtin_install_never_overwrites_user_scripts(self):
        with tempfile.TemporaryDirectory() as directory:
            first = resources.install_bundled_plugins(directory)
            self.assertEqual(set(first['installed']), {'calc', 'textstats', 'jm', 'jmv'})
            custom = Path(directory) / 'plugins' / 'python' / 'calc.py'
            custom.write_text("print('my custom calculator')\n", encoding='utf-8')
            second = resources.install_bundled_plugins(directory)
            self.assertFalse(second['installed'])
            self.assertEqual(len(second['kept']), 4)
            self.assertIn('my custom calculator', custom.read_text(encoding='utf-8'))

    def test_wheel_update_version_uses_shipped_baseline_and_rejects_invalid_override(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'instance'
            root.mkdir()
            assets = Path(directory) / 'assets'
            assets.mkdir()
            (assets / 'source-version.json').write_text(json.dumps({'version':'2.31.3'}), encoding='utf-8')
            with patch.object(resources, 'ASSETS', assets), patch.object(resources, 'development_root', return_value=None):
                self.assertEqual(local_version(root), '2.31.3')
                explicit = root / 'package.json'
                explicit.write_text(json.dumps({'version':'2.40.0'}), encoding='utf-8')
                self.assertEqual(local_version(root), '2.40.0')
                explicit.write_text(json.dumps({'version':'0.1.0a1'}), encoding='utf-8')
                with self.assertRaises(ValueError):
                    local_version(root)


class BundledPluginTests(unittest.IsolatedAsyncioTestCase):
    async def test_bundled_calculator_and_sdk_execute_without_node(self):
        with tempfile.TemporaryDirectory() as directory:
            resources.install_bundled_plugins(directory)
            manager = PluginManager(directory)
            with patch.dict(os.environ, {'PATH':''}):
                result = await manager.run('calc', ['1+2'])
                self.assertTrue(result['ok'], result)
                self.assertEqual(result['stdout'], '3')
                manager.create('hello')
                result = await manager.run('hello', ['中文'])
                self.assertTrue(result['ok'], result)
                self.assertEqual(result['stdout'], '收到：中文')
