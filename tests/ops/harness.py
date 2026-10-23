"""Hermetic runner for ops scripts: fake PATH, call log, no real host binaries."""
import json, os, pathlib, shutil, subprocess, sys, tempfile

BASH = 'C:/Program Files/Git/bin/bash.exe' if os.name == 'nt' else 'bash'
FAKES = pathlib.Path(__file__).resolve().parent / 'fakes'
OPS_SOURCE = pathlib.Path(__file__).resolve().parents[2] / 'ops'
UTIL_DIRS = ['C:/Program Files/Git/usr/bin'] if os.name == 'nt' else ['/usr/bin', '/bin']
ENV_FILES = (('web.env', ['DATABASE_URL', 'SESSION_SECRET']), ('mailer.env', ['MAILER_DATABASE_URL']),
             ('migrator.env', ['MIGRATION_DATABASE_URL']))
EFFECT_COMMANDS = ('stop', 'rename', 'run', 'start', 'rm', 'network', 'login', 'pull')


def _posix(path):
    text = pathlib.Path(path).as_posix()
    if os.name == 'nt' and len(text) > 1 and text[1] == ':':
        return '/' + text[0].lower() + text[2:]
    return text


class Result:
    def __init__(self, completed, log_path):
        self.returncode = completed.returncode
        self.stdout = completed.stdout.decode('utf-8', 'replace')
        self.stderr = completed.stderr.decode('utf-8', 'replace')
        text = pathlib.Path(log_path).read_text(encoding='utf-8')
        self._calls = [json.loads(line) for line in text.splitlines() if line]

    def calls(self):
        return list(self._calls)

    def tripwires(self):
        return [c for c in self._calls if c['tripwire']]

    def assert_no_tripwire(self):
        if self.tripwires():
            raise AssertionError('tripwire hit: %r' % (self.tripwires(),))

    def assert_no_effect(self):
        for call in self.calls():
            if call['cmd'] == 'docker' and any(a in EFFECT_COMMANDS for a in call['args'][:3]):
                raise AssertionError('unexpected effect: %r' % (call,))


def run_script(path, stdin, extra_env=None, args=()):
    with tempfile.TemporaryDirectory(prefix='tw-ops-') as scratch:
        log_path = pathlib.Path(scratch) / 'calls.jsonl'
        log_path.write_text('', encoding='utf-8')
        home = pathlib.Path(scratch) / 'home'
        home.mkdir()
        env = {
            'TW_PATH': ':'.join([_posix(FAKES)] + [_posix(d) for d in UTIL_DIRS]),
            'HOME': home.as_posix(),
            'TW_FAKE_LOG': log_path.as_posix(),
        }
        if os.name == 'nt':
            env['SYSTEMROOT'] = os.environ.get('SYSTEMROOT', 'C:/Windows')
        env.update(extra_env or {})
        # Git Bash prepends /usr/bin at startup; reset PATH inside so only the fakes shadow host tools.
        launcher = 'export PATH="$TW_PATH"; exec bash "$@"'
        completed = subprocess.run([BASH, '--noprofile', '--norc', '-c', launcher, 'tw-launcher',
                                    pathlib.Path(path).as_posix(), *map(str, args)], input=stdin.encode('utf-8'),
                                   capture_output=True, env=env)
        return Result(completed, log_path)



class StagedOps:
    """Byte-exact copy of ops/ whose paths.env points at a scratch host tree (no normalization of the scripts)."""

    def __init__(self):
        self._tmp = tempfile.TemporaryDirectory(prefix='tw-staged-')
        root = pathlib.Path(self._tmp.name)
        self.ops = root / 'lib'
        self.host = root / 'host'
        shutil.copytree(OPS_SOURCE, self.ops, ignore=shutil.ignore_patterns('__pycache__'))
        for name in ('lock', 'state', 'app', 'app/dados', 'fake', 'env'):
            (self.host / name).mkdir(parents=True)
        self.fake = self.host / 'fake'
        self.env_dir = self.host / 'env'
        for name, body in ENV_FILES:
            (self.env_dir / name).write_bytes(''.join('%s=TEST-ONLY%s' % (k, chr(10)) for k in body).encode('utf-8'))
        self.script = self.ops / 'deploy.sh'
        (self.ops / 'paths.env').write_bytes(('\n'.join([
            "PATH='%s'" % ':'.join([_posix(FAKES)] + [_posix(d) for d in UTIL_DIRS]),
            "TW_LOCK_FILE='%s'" % (self.host / 'lock/deploy.lock').as_posix(),
            "TW_STATE_DIR='%s'" % (self.host / 'state').as_posix(),
            "TW_APP_DIR='%s'" % (self.host / 'app').as_posix(),
            "TW_ENV_DIR='%s'" % self.env_dir.as_posix(),
            "TW_PYTHON='%s'" % _posix(sys.executable),
            "TW_BASH='%s'" % BASH,
            "TW_DB_FILE='%s'" % (self.host / 'app/dados/tech-woman.db').as_posix(),
            "TW_NETWORK='testnet'",
            # Windows has no uid/mode bits: ownership is only exercised on POSIX (Linux container run).
            'TW_STATE_OWNER_UID=%d' % (os.getuid() if os.name == 'posix' else 0),
            'TW_STATE_MODE_CHECK=%d' % (1 if os.name == 'posix' else 0), '']).encode('utf-8')))
        os.chmod(self.host / 'state', 0o700)

    def run(self, stdin, extra_env=None, script='deploy.sh', args=()):
        env = {'TW_FAKE_DIR': _posix(self.fake)}
        env.update(extra_env or {})
        return run_script(self.ops / script, stdin, env, args)

    def cleanup(self):
        self._tmp.cleanup()


def load_ops_module(name):
    """Import ops/<name>.py by path (ops/ is not a package); isolated per call so tests stay independent."""
    import importlib.util, sys
    path = OPS_SOURCE / (name + '.py')
    sys.path.insert(0, str(OPS_SOURCE))
    try:
        spec = importlib.util.spec_from_file_location('ops_' + name, path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(OPS_SOURCE))
    return module
