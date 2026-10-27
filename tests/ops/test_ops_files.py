import pathlib, subprocess, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]


def tracked(*pathspecs):
    out = subprocess.run(['git', 'ls-files', '-s', '--'] + list(pathspecs), cwd=ROOT, text=True,
                         capture_output=True, check=True).stdout
    return [(line.split()[0], line.split('\t', 1)[1]) for line in out.splitlines()]


class OpsFileHygieneTests(unittest.TestCase):
    def test_shell_scripts_have_real_lf_endings(self):
        files = [ROOT / p for _, p in tracked('ops/*.sh', 'tests/ops/fakes/*')]
        self.assertTrue(files)
        for path in files:
            with self.subTest(path=path.name):
                self.assertNotIn(b'\r', path.read_bytes())

    def test_shell_scripts_are_git_executable(self):
        entries = tracked('ops/*.sh', 'tests/ops/fakes/*')
        self.assertTrue(entries)
        for mode, path in entries:
            with self.subTest(path=path):
                self.assertEqual(mode, '100755')


if __name__ == '__main__':
    unittest.main()
