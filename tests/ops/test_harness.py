import pathlib, tempfile, unittest

from tests.ops import harness

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEPLOY = ROOT / 'ops/deploy.sh'


class HarnessRunTests(unittest.TestCase):
    def test_run_script_rejects_non_digest_with_no_effect(self):
        result = harness.run_script(DEPLOY, 'latest\n')
        self.assertEqual(result.returncode, 64, result.stderr)
        self.assertIn('invalid digest', result.stderr)
        result.assert_no_effect()


class HarnessFakesTests(unittest.TestCase):
    def run_snippet(self, body, stdin=''):
        with tempfile.TemporaryDirectory(prefix='tw-snippet-') as d:
            script = pathlib.Path(d) / 'snippet.sh'
            script.write_bytes(body.encode('utf-8'))
            return harness.run_script(script, stdin)

    def test_tripwire_binary_fails_the_run_and_is_reported(self):
        for name in ('ssh', 'scp', 'gh', 'nginx'):
            with self.subTest(name=name):
                result = self.run_snippet('%s --version\n' % name)
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual([c['cmd'] for c in result.tripwires()], [name])
                with self.assertRaises(AssertionError):
                    result.assert_no_tripwire()

    def test_read_only_host_inspection_is_allowed_and_every_mutation_is_a_tripwire(self):
        allowed = self.run_snippet('systemctl list-timers --all --no-pager\ncrontab -l\nfuser -v /x\ntrue\n')
        self.assertEqual(allowed.returncode, 0, allowed.stderr)
        allowed.assert_no_tripwire()
        for command in ('systemctl restart nginx', 'systemctl stop tech-woman', 'systemctl daemon-reload',
                        'crontab -r', 'crontab /tmp/x', 'crontab -e'):
            with self.subTest(command=command):
                result = self.run_snippet(command + chr(10))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(len(result.tripwires()), 1)

    def test_logging_fakes_record_argv(self):
        result = self.run_snippet('docker stop tech-woman\nfuser -v /x\ntrue\n')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([(c['cmd'], c['args']) for c in result.calls()],
                         [('docker', ['stop', 'tech-woman']), ('fuser', ['-v', '/x'])])
        with self.assertRaises(AssertionError):
            result.assert_no_effect()
        result.assert_no_tripwire()

    def test_fake_log_roundtrips_hostile_arguments(self):
        hostile = 'a"b\\c;$(x)\nd\te\rf'
        result = self.run_snippet('IFS= read -r -d "" arg\ndocker "$arg"\n', stdin=hostile)
        self.assertEqual([c['args'] for c in result.calls()], [[hostile]])

    def test_path_resolves_host_tools_to_fakes_and_home_is_fake(self):
        body = 'for t in ssh docker curl flock fuser nginx; do command -v "$t"; done\necho "HOME=$HOME"\n'
        lines = self.run_snippet(body).stdout.splitlines()
        for resolved in lines[:6]:
            self.assertIn('tests/ops/fakes/', resolved)
        self.assertIn('/tw-ops-', lines[6])
        self.assertNotIn('della', lines[6])


if __name__ == '__main__':
    unittest.main()
