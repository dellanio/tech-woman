import json, unittest

from tests.ops.hostfixture import Host


def docker_calls(result):
    return [c['args'] for c in result.calls() if c['cmd'] == 'docker']


class VerifyImageHappyPathTests(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.host.good_image()

    def test_a_matching_image_is_verified_with_isolated_read_only_docker_calls(self):
        result = self.host.verify_image()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(json.loads(result.stdout)['verified'])
        calls = docker_calls(result)
        self.assertTrue(any(a[:2] == ['image', 'inspect'] for a in calls))
        runs = [a for a in calls if a[0] == 'run']
        self.assertGreaterEqual(len(runs), 5)
        for args in runs:
            self.assertIn('--rm', args)
            index = args.index('--network')
            self.assertEqual(args[index + 1], 'none')
        for forbidden in ('stop', 'rename', 'start', 'login', 'pull', 'rm', 'network'):
            self.assertFalse([a for a in calls if a[0] == forbidden], forbidden)
        result.assert_no_tripwire()


if __name__ == '__main__':
    unittest.main()
