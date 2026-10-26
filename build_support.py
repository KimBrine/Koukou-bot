"""Copy only public runtime assets into Python distributions; no Node build step."""
import json
from pathlib import Path
import shutil

from setuptools.command.build_py import build_py


FRONTEND_FILES = ('ui.html', 'ui.css', 'app.js', 'commandCenter.js', 'stickerUpload.js')
PLUGIN_FILES = ('calc.py', 'textstats.py', 'jm.py', 'jmv.py')


class BuildPy(build_py):
    def run(self):
        super().run()
        source = Path(__file__).resolve().parent
        target = Path(self.build_lib) / 'koukou' / 'assets'
        files = [(source / 'src' / 'admin' / name, target / 'admin' / name)
                 for name in FRONTEND_FILES]
        files += [(source / 'plugins' / 'python' / name, target / 'plugins' / name)
                  for name in PLUGIN_FILES]
        files.append((source / 'python' / 'migration-contract.json', target / 'migration-contract.json'))
        for original, destination in files:
            if not original.is_file() or original.is_symlink():
                raise RuntimeError('Missing or linked public Python distribution resource: '+str(original))
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(original, destination)
        # Include only the public version, never environment or instance files.
        version = json.loads((source / 'package.json').read_text(encoding='utf-8-sig'))['version']
        (target / 'source-version.json').write_text(json.dumps({'version': version})+'\n', encoding='utf-8')
