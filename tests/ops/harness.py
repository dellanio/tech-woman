"""Hermetic runner for ops scripts: fake PATH, call log, no real host binaries."""
import json, os, pathlib, subprocess, tempfile

BASH = 'C:/Program Files/Git/bin/bash.exe' if os.name == 'nt' else 'bash'
FAKES = pathlib.Path(__file__).resolve().parent / 'fakes'
UTIL_DIRS = ['C:/Program Files/Git/usr/bin'] if os.name == 'nt' else ['/usr/bin', '/bin']
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


def run_script(path, stdin, extra_env=None):
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
        launcher = 'PATH="$TW_PATH"; exec bash "$1"'
        completed = subprocess.run([BASH, '--noprofile', '--norc', '-c', launcher, 'tw-launcher',
                                    pathlib.Path(path).as_posix()], input=stdin.encode('utf-8'),
                                   capture_output=True, env=env)
        return Result(completed, log_path)

