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
    def run_snippet(self, body):
        with tempfile.TemporaryDirectory(prefix='tw-snippet-') as d:
            script = pathlib.Path(d) / 'snippet.sh'
            script.write_bytes(body.encode('utf-8'))
            return harness.run_script(script, '')

    def test_tripwire_binary_fails_the_run_and_is_reported(self):
        for name in ('ssh', 'scp', 'gh', 'nginx', 'systemctl'):
            with self.subTest(name=name):
                result = self.run_snippet('%s --version' % name + chr(10))
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual([c['cmd'] for c in result.tripwires()], [name])
                with self.assertRaises(AssertionError):
                    result.assert_no_tripwire()

    def test_logging_fakes_record_argv(self):
        result = self.run_snippet(chr(10).join(['docker stop tech-woman', 'fuser -v /x', '']))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual([(c['cmd'], c['args']) for c in result.calls()],
                         [('docker', ['stop', 'tech-woman']), ('fuser', ['-v', '/x'])])
        with self.assertRaises(AssertionError):
            result.assert_no_effect()
        result.assert_no_tripwire()


if __name__ == '__main__':
    unittest.main()
