import json, unittest

from tests.ops.hostfixture import Host, COMMIT


class GateTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)

    def prepare(self, facts=None):
        self.host.seal(facts)
        done = self.host.cutover('prepare')
        self.assertEqual(done.returncode, 0, done.stderr)

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
        result = self.host.deploy()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual((report['gate'], report['op'], report['phase']), ('ok', 'stage', 'prepared'))
        self.assertEqual([c['cmd'] for c in result.calls()], ['flock'])
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


if __name__ == '__main__':
    unittest.main()
