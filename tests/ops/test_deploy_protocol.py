import hashlib, json, pathlib, subprocess, tempfile, unittest

from tests.ops import harness

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEPLOY = ROOT / 'ops/deploy.sh'

DIGEST = 'sha256:' + '1' * 64
COMMIT = 'a' * 40
TREE = 'b' * 40
AGGREGATE = 'c' * 64
SECRET = 'TEST-ONLY-SECRET_token.value'


def request(*lines, end='\n'):
    return '\n'.join(lines) + end


def deploy_lines(**changes):
    fields = {'header': 'TWDEPLOY/2', 'op': 'deploy', 'digest': DIGEST, 'commit': COMMIT, 'tree': TREE,
              'aggregate': AGGREGATE, 'count': '27', 'token': SECRET}
    fields.update(changes)
    return [fields[k] for k in ('header', 'op', 'digest', 'commit', 'tree', 'aggregate', 'count', 'token')]


class ProbeTests(unittest.TestCase):
    def test_probe_reports_script_hash_and_touches_no_host_tool(self):
        result = harness.run_script(DEPLOY, request('TWDEPLOY/2', 'probe'))
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['protocol'], 2)
        self.assertEqual(report['script_sha256'], hashlib.sha256(DEPLOY.read_bytes()).hexdigest())
        self.assertEqual(result.stderr, '')
        self.assertEqual(result.calls(), [])

    def test_previous_script_rejects_the_v2_probe_without_effect(self):
        legacy = subprocess.run(['git', 'show', 'aadb3cb:ops/deploy.sh'], cwd=ROOT, capture_output=True,
                                check=True).stdout
        with tempfile.TemporaryDirectory(prefix='tw-legacy-') as tmp:
            script = pathlib.Path(tmp) / 'deploy.sh'
            script.write_bytes(legacy)
            result = harness.run_script(script, request('TWDEPLOY/2', 'probe'))
        self.assertEqual(result.returncode, 64, result.stderr)
        self.assertIn('invalid digest', result.stderr)
        self.assertEqual(result.calls(), [])


if __name__ == '__main__':
    unittest.main()
