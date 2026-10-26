import json, unittest

from tests.ops import harness

from tests.ops.hostfixture import COMMIT, DIGEST, IMAGE_REF, MIGRATIONS, SECRET, TREE, Host

cutover = harness.load_ops_module('cutover')


def sub_commands(result):
    return [c['args'] for c in result.calls() if c['cmd'] == 'docker']


class StageTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.host.seal()
        self.assertEqual(self.host.cutover('prepare').returncode, 0)
        self.host.good_image()
        self.state_before = (self.host.state_dir / 'state.json').read_bytes()
        self.journal_before = (self.host.state_dir / 'journal.jsonl').read_bytes()

    def assert_marker_untouched(self):
        self.assertEqual((self.host.state_dir / 'state.json').read_bytes(), self.state_before)
        self.assertEqual((self.host.state_dir / 'journal.jsonl').read_bytes(), self.journal_before)

    def assert_no_activation(self, result):
        for args in sub_commands(result):
            self.assertNotIn(args[0] if args[0] != '--config' else args[2], ('stop', 'rename', 'start', 'rm', 'network'))
            if args[0] == 'run':
                self.assertIn('--rm', args)
                self.assertNotIn('-d', args)
        result.assert_no_tripwire()


class StageHappyPathTests(StageTestCase):
    def test_stage_pulls_verifies_and_attests_without_touching_the_marker_or_any_container(self):
        result = self.host.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        attestation = report['attestation']
        candidate = json.loads((self.host.state_dir / 'candidate.json').read_text())
        self.assertEqual(report['stage'], 'verified')
        self.assertEqual((attestation['digest'], attestation['release_commit'], attestation['release_tree']),
                         (DIGEST, COMMIT, TREE))
        self.assertEqual(attestation['migrations_count'], len(MIGRATIONS))
        self.assertEqual(attestation['migrations_aggregate'], candidate['migrations']['aggregate_sha256'])
        self.assertEqual(attestation['phase'], 'prepared')
        self.assertRegex(attestation['candidate_sha256'], '^[0-9a-f]{64}$')
        self.assert_marker_untouched()
        self.assert_no_activation(result)
        # token reaches docker login only through stdin, never argv, stdout, stderr or the call log
        calls = sub_commands(result)
        self.assertIn('--password-stdin', next(a for a in calls if 'login' in a))
        self.assertEqual((self.host.ops.fake / 'login.stdin').read_bytes().decode(), SECRET)
        self.assertNotIn(SECRET, result.stdout + result.stderr + json.dumps(result.calls()))
        order = [next(a for a in calls if a is not None and key in a) for key in ('login', 'pull')]
        self.assertEqual(order[1][-1], IMAGE_REF)
        self.assertLess(calls.index(order[0]), calls.index(order[1]))
        self.assertLess(calls.index(order[1]), next(i for i, a in enumerate(calls) if a[:2] == ['image', 'inspect']))


class StageDenialTests(StageTestCase):
    def denied(self, code):
        result = self.host.deploy()
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assert_marker_untouched()
        self.assert_no_activation(result)
        self.assertNotIn(SECRET, result.stderr + json.dumps(result.calls()))

    def test_every_image_failure_stops_the_stage_with_its_code_and_no_attestation(self):
        fake = self.host.ops.fake
        (fake / 'inspect').write_bytes(('amd64|linux|' + COMMIT + chr(10)).encode())
        self.denied(74)
        self.host.good_image()
        (fake / 'grep.rc').write_bytes(b'0')
        self.denied(76)
        self.host.good_image()
        (self.host.ops.env_dir / 'web.env').write_bytes(b'MIGRATION_DATABASE_URL=TEST-ONLY' + bytes([10]))
        self.denied(74)

    def test_registry_failures_are_74_and_never_reach_verification(self):
        for name in ('login.rc', 'pull.rc'):
            with self.subTest(name=name):
                self.host.good_image()
                (self.host.ops.fake / name).write_bytes(b'1')
                result = self.host.deploy()
                self.assertEqual(result.returncode, 74, result.stderr)
                self.assertFalse([a for a in sub_commands(result) if a[:2] == ['image', 'inspect']])
                self.assertEqual(result.stdout, '')
                self.assertNotIn(SECRET, result.stderr)
                self.assert_marker_untouched()


class RegisterStageTests(StageTestCase):
    def attestation(self):
        done = self.host.deploy()
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def register(self, text=None):
        return self.host.cutover('register-stage', stdin=self.attestation() if text is None else text)

    def test_operator_registers_the_verified_attestation_without_changing_the_phase(self):
        done = self.register()
        self.assertEqual(done.returncode, 0, done.stderr)
        status = json.loads(self.host.cutover('status').stdout)
        self.assertEqual((status['phase'], status['seq']), ('prepared', 2))
        state = json.loads((self.host.state_dir / 'state.json').read_text())
        self.assertEqual({k: state['staged'][k] for k in ('digest', 'release_commit', 'release_tree')},
                         {'digest': DIGEST, 'release_commit': COMMIT, 'release_tree': TREE})
        self.assertRegex(state['staged']['at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        # the operator re-verified the image locally instead of trusting the SSH output
        log = (self.host.work / 'cutover-calls.jsonl').read_text()
        self.assertIn('inspect', log)
        self.assertNotIn('"stop"', log)

    def test_attestation_that_does_not_match_the_candidate_the_host_or_the_script_is_refused(self):
        good = json.loads(self.attestation())
        def mutate(path, value):
            data = json.loads(json.dumps(good))
            data['attestation'][path] = value
            return json.dumps(data)
        cases = {
            'other candidate': (70, mutate('candidate_sha256', 'e' * 64)),
            'other tree': (71, mutate('release_tree', 'f' * 40)),
            'other migrations': (72, mutate('migrations_aggregate', 'f' * 64)),
            'other script': (65, mutate('script_sha256', 'f' * 64)),
            'bad digest': (64, mutate('digest', 'latest')),
            'unknown field': (64, mutate('surprise', 1)),
            'not json': (64, 'nope'),
            'empty': (64, ''),
        }
        for name, (code, text) in cases.items():
            with self.subTest(name=name):
                done = self.register(text)
                self.assertEqual(done.returncode, code, done.stderr)
                self.assert_marker_untouched()

    def test_operator_reverification_failure_and_wrong_phase_do_not_register(self):
        text = self.attestation()
        (self.host.ops.fake / 'inspect').write_bytes(('amd64|linux|' + COMMIT + chr(10)).encode())
        self.assertEqual(self.register(text).returncode, 74)
        self.assert_marker_untouched()
        self.host.good_image()
        state = cutover.State.load(self.host.state_dir, cutover.UNCHECKED)
        state.transition('frozen', '2026-10-23T12:00:00Z')
        self.assertEqual(self.register(text).returncode, 75)


if __name__ == '__main__':
    unittest.main()
