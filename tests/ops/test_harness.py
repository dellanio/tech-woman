import pathlib, unittest

from tests.ops import harness

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEPLOY = ROOT / 'ops/deploy.sh'


class HarnessRunTests(unittest.TestCase):
    def test_run_script_rejects_non_digest_with_no_effect(self):
        result = harness.run_script(DEPLOY, 'latest\n')
        self.assertEqual(result.returncode, 64, result.stderr)
        self.assertIn('invalid digest', result.stderr)
        result.assert_no_effect()


if __name__ == '__main__':
    unittest.main()
