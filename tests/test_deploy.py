import pathlib, unittest

from tests.ops import harness

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'ops/deploy.sh'
class DeployTests(unittest.TestCase):
    def test_rejects_non_digest_before_side_effects(self):
        result = harness.run_script(SCRIPT, 'latest\n')
        self.assertEqual(result.returncode, 64, result.stderr)
        self.assertIn('invalid digest', result.stderr)
        result.assert_no_effect()
        result.assert_no_tripwire()
if __name__ == '__main__': unittest.main()
