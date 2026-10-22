import os, pathlib, subprocess, unittest
BASH = 'C:/Program Files/Git/bin/bash.exe' if os.name == 'nt' else 'bash'

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'ops/deploy.sh'
class DeployTests(unittest.TestCase):
    def test_rejects_non_digest_before_side_effects(self):
        result = subprocess.run([BASH, SCRIPT.as_posix()], input='latest\n', text=True, capture_output=True)
        self.assertEqual(result.returncode, 64, result.stderr)
        self.assertIn('invalid digest', result.stderr)
if __name__ == '__main__': unittest.main()
