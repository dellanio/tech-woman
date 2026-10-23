"""Hermetic runner for ops scripts: fake PATH, call log, no real host binaries."""
import json, os, pathlib, subprocess, tempfile

BASH = 'C:/Program Files/Git/bin/bash.exe' if os.name == 'nt' else 'bash'
FAKES = pathlib.Path(__file__).resolve().parent / 'fakes'
UTIL_DIRS = ['C:/Program Files/Git/usr/bin'] if os.name == 'nt' else ['/usr/bin', '/bin']
EFFECT_COMMANDS = ('stop', 'rename', 'run', 'start', 'rm', 'network', 'login', 'pull')


class Result:
    def __init__(self, completed, log_path):
        self.returncode = completed.returncode
        self.stdout = completed.stdout
        self.stderr = completed.stderr
        text = pathlib.Path(log_path).read_text(encoding='utf-8')
        self._calls = [json.loads(line) for line in text.splitlines() if line]

    def calls(self):
        return list(self._calls)

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
            'PATH': os.pathsep.join([FAKES.as_posix()] + UTIL_DIRS),
            'HOME': home.as_posix(),
            'TW_FAKE_LOG': log_path.as_posix(),
        }
        if os.name == 'nt':
            env['SYSTEMROOT'] = os.environ.get('SYSTEMROOT', 'C:/Windows')
        env.update(extra_env or {})
        completed = subprocess.run([BASH, pathlib.Path(path).as_posix()], input=stdin, text=True,
                                   capture_output=True, env=env)
        return Result(completed, log_path)

