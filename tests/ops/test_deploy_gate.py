import hashlib, json, unittest

from tests.ops import harness
from tests.ops.hostfixture import Host
from tests.ops.test_state import PHASES, path_to

cutover = harness.load_ops_module('cutover')


class GateTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)

    def prepare(self, facts=None):
        self.host.seal(facts)
        done = self.host.cutover('prepare')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.host.good_image()

    def assert_denied_before_any_effect(self, result, code):
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertEqual(result.stdout, '')
        self.assertNotIn('TEST-ONLY-SECRET', result.stderr)
        self.assertEqual([c['cmd'] for c in result.calls()], ['flock'])
        result.assert_no_effect()
        result.assert_no_tripwire()


class GateBasicsTests(GateTestCase):
    def test_prepared_marker_and_exact_candidate_pass_the_gate_without_effect(self):
        self.prepare()
        self.host.good_image()
        result = self.host.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual((report['stage'], report['attestation']['phase']), ('verified', 'prepared'))
        self.assertEqual(result.calls()[0]['cmd'], 'flock')
        self.assertNotIn('TEST-ONLY-SECRET', result.stdout + result.stderr)

    def test_missing_marker_is_70(self):
        self.host.seal()
        self.assert_denied_before_any_effect(self.host.deploy(), 70)

    def test_edited_marker_is_70(self):
        self.prepare()
        path = self.host.state_dir / 'state.json'
        path.write_text(path.read_text().replace('"prepared"', '"pg_write_open"'))
        self.assert_denied_before_any_effect(self.host.deploy(), 70)

    def test_candidate_replaced_after_prepare_is_70(self):
        self.prepare()
        other = self.host.facts()
        other['tested_head'] = 'e' * 40
        other['ci']['head_sha'] = 'e' * 40
        self.host.seal(other)
        self.assert_denied_before_any_effect(self.host.deploy(), 70)


class GateDenialTests(GateTestCase):
    def test_drift_in_any_installed_file_is_65_before_anything_else(self):
        for name, change in {
            'deploy.sh': lambda ops: ops.script.write_bytes(ops.script.read_bytes() + b'# drift\n'),
            'helper': lambda ops: (ops.ops / 'manifest.py').write_bytes((ops.ops / 'manifest.py').read_bytes() + b'#\n'),
            'cutover': lambda ops: (ops.ops / 'cutover.py').write_bytes((ops.ops / 'cutover.py').read_bytes() + b'#\n'),
            'extra file': lambda ops: (ops.ops / 'extra.py').write_bytes(b'print(1)\n'),
            'paths.env': lambda ops: (ops.ops / 'paths.env').write_bytes((ops.ops / 'paths.env').read_bytes() + b'#\n'),
        }.items():
            with self.subTest(name=name):
                self.host = Host(self)
                self.prepare()
                change(self.host.ops)
                self.assert_denied_before_any_effect(self.host.deploy(), 65)

    def test_release_identity_and_migrations_must_equal_the_candidate(self):
        self.prepare()
        migrations = self.host.migrations()
        self.assert_denied_before_any_effect(self.host.deploy(tree='f' * 40), 71)
        self.assert_denied_before_any_effect(self.host.deploy(aggregate='f' * 64), 72)
        self.assert_denied_before_any_effect(self.host.deploy(count=str(migrations['count'] + 1)), 72)
        self.assertEqual(self.host.deploy().returncode, 0)

    def test_squash_commit_with_the_tested_tree_passes_and_main_advance_does_not(self):
        self.prepare()
        self.host.good_image(commit='9' * 40)  # the image is labelled with the squash commit it was built from
        self.assertEqual(self.host.deploy(commit='9' * 40).returncode, 0)
        self.assert_denied_before_any_effect(self.host.deploy(commit='9' * 40, tree='8' * 40), 71)

    def test_stage_outside_the_window_is_73(self):
        for name, authorized, expires in (('expired', -7200, -3600), ('not started', 3600, 7200)):
            with self.subTest(name=name):
                self.host = Host(self)
                self.host.seal(self.host.facts(authorized=authorized, expires=expires))
                digest = hashlib.sha256((self.host.state_dir / 'candidate.json').read_bytes()).hexdigest()
                cutover.State.create(self.host.state_dir, digest, '2026-10-23T12:00:00Z')
                self.assert_denied_before_any_effect(self.host.deploy(), 73)


class PhaseMatrixTests(GateTestCase):
    def walk_to(self, phase):
        state = cutover.State.load(self.host.state_dir, cutover.UNCHECKED)
        for step in path_to(phase)[1:]:
            state.transition(step, '2026-10-23T12:00:00Z')

    def test_phase_by_operation_matrix(self):
        # pg_write_open reaches the release gate; the library walk records no schema, so the gate stops it at 72
        outcomes = {}
        for phase in PHASES:
            self.host = Host(self)
            self.prepare()
            self.host.good_image()
            self.walk_to(phase)
            result = self.host.deploy()
            outcomes[phase] = result.returncode
            if result.returncode:
                self.assert_denied_before_any_effect(result, result.returncode)
            elif phase == 'prepared':
                self.assertEqual(json.loads(result.stdout)['attestation']['phase'], phase)
        self.assertEqual(outcomes, {
            'prepared': 0, 'frozen': 75, 'snapshotted': 75, 'imported': 75, 'activated': 75, 'smoke_ok': 75,
            'pg_write_open': 72, 'aborted_pre_write': 75, 'recovering': 75})

    def test_pg_write_open_is_a_release_and_ignores_the_stage_window(self):
        self.host.window = {'authorized': -7200, 'expires': -3600}  # the stage window is long over
        self.host.pg_open()
        self.host.good_image()
        result = self.host.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['op'], 'release')


class ProbePhaseTests(GateTestCase):
    def probe(self):
        return self.host.ops.run('TWDEPLOY/2' + chr(10) + 'probe' + chr(10))

    def test_probe_reports_the_phase_read_only_and_never_a_secret(self):
        self.prepare()
        report = json.loads(self.probe().stdout)
        self.assertEqual((report['protocol'], report['phase']), (2, 'prepared'))
        self.assertEqual(report['script_sha256'], hashlib.sha256(self.host.ops.script.read_bytes()).hexdigest())
        state = cutover.State.load(self.host.state_dir, cutover.UNCHECKED)
        state.transition('frozen', '2026-10-23T12:00:00Z')
        self.assertEqual(json.loads(self.probe().stdout)['phase'], 'frozen')

    def test_probe_without_a_readable_marker_says_so_and_has_no_effect(self):
        result = self.probe()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['phase'], 'unreadable')
        self.assertEqual(result.calls(), [])


if __name__ == '__main__':
    unittest.main()
