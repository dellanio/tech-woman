import hashlib, json, pathlib, unittest

from tests.ops import harness
from tests.ops.hostfixture import Host

ROOT = pathlib.Path(__file__).resolve().parents[2]


class ProductionPathsTests(unittest.TestCase):
    def test_repository_paths_env_is_the_strict_production_configuration(self):
        values = dict(line.split('=', 1) for line in (ROOT / 'ops/paths.env').read_text().splitlines()
                      if line and not line.startswith('#'))
        self.assertEqual(values['TW_STATE_DIR'], '/var/lib/tech-woman-cutover')
        self.assertEqual(values['TW_STATE_OWNER_UID'], '0')
        self.assertEqual(values['TW_STATE_MODE_CHECK'], '1')
        self.assertEqual(values['TW_PYTHON'], '/usr/bin/python3')
        self.assertEqual(values['TW_LOCK_FILE'], '/var/lock/tech-woman-deploy.lock')
        self.assertTrue(values['PATH'].startswith('/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin'))


class PrepareTests(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)

    def test_prepare_records_the_sealed_candidate_and_status_reports_it(self):
        self.host.seal()
        done = self.host.cutover('prepare')
        self.assertEqual(done.returncode, 0, done.stderr)
        digest = hashlib.sha256((self.host.state_dir / 'candidate.json').read_bytes()).hexdigest()
        status = self.host.cutover('status')
        self.assertEqual(status.returncode, 0, status.stderr)
        report = json.loads(status.stdout)
        self.assertEqual((report['phase'], report['seq'], report['candidate_sha256']), ('prepared', 1, digest))

    def test_prepare_refuses_what_is_not_exactly_the_sealed_installation(self):
        self.host.seal()
        (self.host.ops.ops / 'cutover.py').write_bytes((self.host.ops.ops / 'cutover.py').read_bytes() + b'# drift\n')
        self.assertEqual(self.host.cutover('prepare').returncode, 65)
        self.assertFalse((self.host.state_dir / 'state.json').exists())

    def test_prepare_refuses_an_expired_window(self):
        self.host.seal(self.host.facts(authorized=-7200, expires=-3600))
        self.assertEqual(self.host.cutover('prepare').returncode, 73)
        self.assertFalse((self.host.state_dir / 'state.json').exists())

    def test_prepare_refuses_missing_or_tampered_candidate(self):
        self.assertEqual(self.host.cutover('prepare').returncode, 70)
        candidate = self.host.seal()
        candidate['surprise'] = 1
        (self.host.state_dir / 'candidate.json').write_text(json.dumps(candidate))
        self.assertEqual(self.host.cutover('prepare').returncode, 70)

    def test_prepare_twice_is_refused_with_75(self):
        self.host.seal()
        self.assertEqual(self.host.cutover('prepare').returncode, 0)
        self.assertEqual(self.host.cutover('prepare').returncode, 75)

    def test_status_without_a_marker_is_70(self):
        self.assertEqual(self.host.cutover('status').returncode, 70)


if __name__ == '__main__':
    unittest.main()
