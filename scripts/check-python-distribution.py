"""Offline sdist -> wheel -> isolated install -> console/SDK acceptance.

Requires the declared build backend (setuptools>=77) in the calling Python
environment. No package index, Node executable, real QQ, or model is used.
"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import zipfile


ROOT = Path(__file__).resolve().parents[1]


def run(argv, *, cwd=None, env=None):
    result = subprocess.run(argv, cwd=cwd, env=env, capture_output=True,
                            text=True, encoding='utf-8', timeout=120)
    if result.returncode:
        raise RuntimeError('Python distribution check failed:\n'+result.stdout[-3000:]+'\n'+result.stderr[-3000:])
    return result.stdout


def main():
    with tempfile.TemporaryDirectory(prefix='koukou-distribution-') as directory:
        work = Path(directory)
        output = work / 'dist'
        output.mkdir()
        environment = {**os.environ, 'PYTHONUTF8':'1', 'PYTHONDONTWRITEBYTECODE':'1',
                       'PIP_NO_INDEX':'1', 'PIP_DISABLE_PIP_VERSION_CHECK':'1'}
        run([sys.executable, '-X', 'utf8', '-c',
             'from setuptools.build_meta import build_sdist; build_sdist('+repr(str(output))+')'],
            cwd=ROOT, env=environment)
        archives = list(output.glob('*.tar.gz'))
        if len(archives) != 1:
            raise RuntimeError('Expected one source distribution')
        extracted = work / 'source'
        extracted.mkdir()
        with tarfile.open(archives[0], 'r:gz') as archive:
            for member in archive.getmembers():
                destination = (extracted / member.name).resolve()
                if not destination.is_relative_to(extracted.resolve()) or member.issym() or member.islnk():
                    raise RuntimeError('Unsafe source distribution path')
            # Python 3.11 is supported; explicit checked paths above also cover
            # runtimes without the newer tarfile extraction-filter keyword.
            archive.extractall(extracted)
        sources = list(extracted.iterdir())
        if len(sources) != 1 or not (sources[0] / 'pyproject.toml').is_file():
            raise RuntimeError('Invalid source distribution root')
        run([sys.executable, '-X', 'utf8', '-c',
             'from setuptools.build_meta import build_wheel; build_wheel('+repr(str(output))+')'],
            cwd=sources[0], env=environment)
        wheels = list(output.glob('*.whl'))
        if len(wheels) != 1:
            raise RuntimeError('Expected one wheel')
        required = {'koukou/assets/admin/'+name for name in
                    ('ui.html','ui.css','app.js','commandCenter.js','stickerUpload.js')}
        required |= {'koukou/assets/plugins/'+name for name in ('calc.py','textstats.py','jm.py','jmv.py')}
        required |= {'koukou/assets/migration-contract.json','koukou/assets/source-version.json',
                     'koukou/plugin.py','koukou/windows_restart.ps1'}
        with zipfile.ZipFile(wheels[0]) as package:
            names = set(package.namelist())
            if required - names:
                raise RuntimeError('Missing wheel resources: '+','.join(sorted(required-names)))
            if any(not (name.startswith('koukou/') or '.dist-info/' in name) for name in names):
                raise RuntimeError('Wheel contains unrelated source/build files')
            if any(part in {'.env','node_modules','server.js','index.js'} for name in names for part in name.split('/')):
                raise RuntimeError('Wheel unexpectedly contains instance data or Node backend')
        installed = work / 'installed'
        run([sys.executable, '-m', 'pip', 'install', '--no-index', '--no-deps',
             '--no-compile', '--target', str(installed), str(wheels[0])], env=environment)
        empty = work / 'empty-cwd'
        empty.mkdir()
        environment.update(PATH='', KOUKOU_INSTANCE_DIR=str(work / 'instance'))
        answer = run([sys.executable, '-B', '-I', '-X', 'utf8',
                      str(ROOT / 'python' / 'tests' / 'package_probe.py'),
                      str(installed), str(work / 'instance')], cwd=empty, env=environment)
        report = json.loads(answer)
        if report.get('ok') is not True:
            raise RuntimeError('Installed Python package probe did not pass')
        print(json.dumps({'ok':True, 'wheel':wheels[0].name, 'sdist':archives[0].name,
                          'nodeRequired':False, 'checks':report['checks']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
