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


class ProtocolRejectionTests(unittest.TestCase):
    def assert_rejected(self, stdin):
        result = harness.run_script(DEPLOY, stdin)
        self.assertEqual(result.returncode, 64, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('SECRET', result.stderr)
        self.assertEqual(result.calls(), [])

    def test_malformed_requests_exit_64_without_effect_or_echo(self):
        cases = {
            'empty': '',
            'legacy latest': 'latest\n',
            'legacy digest first': request(DIGEST, SECRET),
            'old header': request(*deploy_lines(header='TWDEPLOY/1')),
            'header trailing space': request(*deploy_lines(header='TWDEPLOY/2 ')),
            'unknown op': request(*deploy_lines(op='redeploy')),
            'upper-case op': request(*deploy_lines(op='DEPLOY')),
            'probe with extra line': request('TWDEPLOY/2', 'probe', 'x'),
            'deploy without token': request(*deploy_lines()[:-1]),
            'deploy with extra line': request(*deploy_lines(), 'extra'),
            'digest latest': request(*deploy_lines(digest='latest')),
            'digest short': request(*deploy_lines(digest='sha256:abc')),
            'digest upper-case hex': request(*deploy_lines(digest='sha256:' + 'A' * 64)),
            'protocol token as digest': request(*deploy_lines(digest='TWDEPLOY/2')),
            'commit 39 hex': request(*deploy_lines(commit='a' * 39)),
            'tree not hex': request(*deploy_lines(tree='z' * 40)),
            'aggregate 63 hex': request(*deploy_lines(aggregate='c' * 63)),
            'count not a number': request(*deploy_lines(count='x')),
            'count negative': request(*deploy_lines(count='-1')),
            'count leading zero': request(*deploy_lines(count='01')),
            'token with space': request(*deploy_lines(token='abc def')),
            'token with command substitution': request(*deploy_lines(token='$(touch_x)' + SECRET)),
            'token with semicolon': request(*deploy_lines(token='a;b' + SECRET)),
            'token with quote': request(*deploy_lines(token='a"b' + SECRET)),
            'token non-ascii': request(*deploy_lines(token='café' + SECRET)),
            'token control char': request(*deploy_lines(token='a\x1bb' + SECRET)),
            'token tab': request(*deploy_lines(token='a\tb' + SECRET)),
            'token carriage return': request(*deploy_lines(token='a\rb' + SECRET)),
            'token NUL byte': request(*deploy_lines(token='a\x00b' + SECRET)),
            'token oversize': request(*deploy_lines(token='t' * 513)),
            'line over 4096 bytes': request(*deploy_lines(digest='sha256:' + '1' * 5000)),
            'CRLF header': 'TWDEPLOY/2\r\nprobe\r\n',
            'no trailing newline': request('TWDEPLOY/2', 'probe', end=''),
            'blank line': request('TWDEPLOY/2', '', 'probe'),
            'huge input': 'x' * 100000,
        }
        for name, stdin in cases.items():
            with self.subTest(name=name):
                self.assert_rejected(stdin)


class LockTests(unittest.TestCase):
    def staged(self):
        ops = harness.StagedOps()
        self.addCleanup(ops.cleanup)
        return ops

    def test_busy_lock_exits_66_before_anything_else_and_leaks_no_token(self):
        result = self.staged().run(request(*deploy_lines()), extra_env={'TW_FAKE_FLOCK': 'busy'})
        self.assertEqual(result.returncode, 66, result.stderr)
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.assertEqual([c['cmd'] for c in result.calls()], ['flock'])
        self.assertEqual(result.calls()[0]['args'][0], '-n')

    def test_free_lock_proceeds_to_the_marker_check(self):
        result = self.staged().run(request(*deploy_lines()))
        self.assertEqual(result.returncode, 70, result.stderr)
        self.assertEqual([c['cmd'] for c in result.calls()], ['flock'])

    def test_malformed_request_is_rejected_before_the_lock_is_taken(self):
        result = self.staged().run('latest\n', extra_env={'TW_FAKE_FLOCK': 'busy'})
        self.assertEqual(result.returncode, 64, result.stderr)
        self.assertEqual(result.calls(), [])


class ProbeTests(unittest.TestCase):
    def test_probe_reports_script_hash_and_touches_no_host_tool(self):
        ops = harness.StagedOps()
        self.addCleanup(ops.cleanup)
        result = ops.run(request('TWDEPLOY/2', 'probe'))
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['protocol'], 2)
        self.assertEqual(report['script_sha256'], hashlib.sha256(ops.script.read_bytes()).hexdigest())
        self.assertEqual(result.stderr, '')
        self.assertEqual(result.calls(), [])

    def test_well_formed_deploy_is_accepted_by_the_parser_and_fails_closed_without_marker(self):
        for token in (SECRET, 'ghp_AbC123_dEf456', 'github_pat_11ABC_xyz-0.9', 'a/b+c=='):
            with self.subTest(token=token):
                ops = harness.StagedOps()
                self.addCleanup(ops.cleanup)
                result = ops.run(request(*deploy_lines(token=token)))
                self.assertEqual(result.returncode, 70, result.stderr)
                self.assertIn('state marker', result.stderr)
                self.assertNotIn(token, result.stdout + result.stderr)
                self.assertEqual([c['cmd'] for c in result.calls()], ['flock'])

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
