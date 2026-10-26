"""Read-only shipped resources separated from the writable instance directory."""
import os
from pathlib import Path
import sys


FRONTEND_FILES = ('ui.html', 'ui.css', 'app.js', 'commandCenter.js', 'stickerUpload.js')
PLUGIN_FILES = ('calc.py', 'textstats.py', 'jm.py', 'jmv.py')
ASSETS = Path(__file__).resolve().parent / 'assets'


def development_root():
    candidate = Path(__file__).resolve().parents[2]
    return candidate if (candidate / 'pyproject.toml').is_file() and (candidate / 'src' / 'admin' / 'ui.html').is_file() else None


def default_instance_root(*, environ=None, platform=sys.platform, home=None):
    """Use a stable writable user directory for wheels, never site-packages/cwd."""
    env = os.environ if environ is None else environ
    explicit = env.get('KOUKOU_INSTANCE_DIR')
    if explicit:
        value = Path(explicit).expanduser()
        if not value.is_absolute():
            raise ValueError('KOUKOU_INSTANCE_DIR必须是绝对路径')
        return value.resolve()
    source = development_root()
    if source is not None:
        return source
    user_home = Path(home or Path.home()).expanduser().resolve()
    if platform == 'win32':
        base = Path(env.get('LOCALAPPDATA') or user_home / 'AppData' / 'Local')
        return (base if base.is_absolute() else user_home / 'AppData' / 'Local') / 'KoukouStudio'
    if platform == 'darwin':
        return user_home / 'Library' / 'Application Support' / 'KoukouStudio'
    base = Path(env.get('XDG_DATA_HOME') or user_home / '.local' / 'share')
    return (base if base.is_absolute() else user_home / '.local' / 'share') / 'koukou-studio'


def frontend_assets(root=None):
    """An explicit source tree can supply the UI; installed wheels carry a copy."""
    if root is not None:
        candidate = Path(root) / 'src' / 'admin'
        if (candidate / 'ui.html').is_file():
            return candidate
    if (ASSETS / 'admin' / 'ui.html').is_file():
        return ASSETS / 'admin'
    source = development_root()
    if source is not None:
        return source / 'src' / 'admin'
    raise FileNotFoundError('当前Python安装缺少控制台静态资源，请重新安装完整wheel')


def migration_contract(root=None):
    candidates = [Path(root) / 'python' / 'migration-contract.json'] if root is not None else []
    candidates.append(ASSETS / 'migration-contract.json')
    source = development_root()
    if source is not None:
        candidates.append(source / 'python' / 'migration-contract.json')
    return next((path for path in candidates if path.is_file()), None) or _missing_contract()


def _missing_contract():
    raise FileNotFoundError('当前Python安装缺少迁移验收清单，请重新安装完整wheel')


def source_version_file(root=None):
    """Locate the shipped JS baseline version, distinct from Python alpha metadata."""
    candidates = [Path(root) / 'package.json'] if root is not None else []
    candidates.append(ASSETS / 'source-version.json')
    source = development_root()
    if source is not None:
        candidates.append(source / 'package.json')
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError('当前安装缺少公开版本记录，请重新安装完整wheel')


def bundled_plugins():
    if all((ASSETS / 'plugins' / name).is_file() for name in PLUGIN_FILES):
        return {Path(name).stem: ASSETS / 'plugins' / name for name in PLUGIN_FILES}
    source = development_root()
    if source is not None and all((source / 'plugins' / 'python' / name).is_file() for name in PLUGIN_FILES):
        return {Path(name).stem: source / 'plugins' / 'python' / name for name in PLUGIN_FILES}
    raise FileNotFoundError('当前Python安装缺少随附插件，请重新安装完整wheel')


def install_bundled_plugins(root):
    """Explicitly install public examples without replacing any existing plugin."""
    import stat
    directory = Path(root).expanduser().resolve() / 'plugins' / 'python'
    # A writable instance must not redirect plugin installation elsewhere.
    for parent in (directory, directory.parent):
        if parent.is_symlink() or getattr(parent.lstat() if parent.exists() else None, 'st_file_attributes', 0) & getattr(stat, 'FILE_ATTRIBUTE_REPARSE_POINT', 0):
            raise ValueError('插件目录不支持链接或重解析点')
    directory.mkdir(parents=True, exist_ok=True)
    result = {'installed': [], 'kept': []}
    for name, original in bundled_plugins().items():
        destination = directory / original.name
        if destination.is_symlink():
            raise ValueError('现有插件文件不支持链接')
        try:
            with destination.open('x', encoding='utf-8', newline='\n') as stream:
                stream.write(original.read_text(encoding='utf-8-sig'))
                stream.flush()
                os.fsync(stream.fileno())
        except FileExistsError:
            result['kept'].append(name)
        else:
            result['installed'].append(name)
    return result
