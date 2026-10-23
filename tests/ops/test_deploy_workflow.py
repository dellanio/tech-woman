import pathlib, re, subprocess, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
DEPLOY_YML = ROOT / '.github/workflows/deploy.yml'


def workflow():
    return DEPLOY_YML.read_bytes().decode('utf-8').replace(chr(13) + chr(10), chr(10))  # parsing only


def step_blocks(text):
    """Split the deploy job into step blocks (text based: stdlib only, no YAML parser)."""
    job = text.split('\n  deploy:\n', 1)[1]
    parts = re.split(r'\n      - (?=name:|uses:|id:|run:)', '\n' + job.split('    steps:\n', 1)[1])
    return [part for part in parts if part.strip()]


def step_index(text, marker):
    for index, block in enumerate(step_blocks(text)):
        if marker in block:
            return index
    raise AssertionError('step not found: %s' % marker)


def step(text, name):
    return step_blocks(text)[step_index(text, 'name: ' + name)]


class StepOrderAndProbeTests(unittest.TestCase):
    def test_probe_of_the_installed_package_runs_before_any_build_or_push(self):
        text = workflow()
        order = [step_index(text, m) for m in ('name: Resolve immutable release', 'name: Install deploy key',
                                               'name: Probe installed deploy package',
                                               'docker/build-push-action', 'name: Stage or release')]
        self.assertEqual(order, sorted(order))
        self.assertEqual(len(set(order)), 5)
        probe = step(text, 'Probe installed deploy package')
        self.assertIn("TWDEPLOY/2", probe)
        self.assertIn('probe', probe)
        self.assertIn('sha256sum ops/deploy.sh', probe)
        self.assertIn('script_sha256', probe)
        self.assertNotIn('build-push', probe)

    def test_remote_request_speaks_protocol_v2_first_and_carries_the_release_identity(self):
        remote = step(workflow(), 'Stage or release')
        request = remote[remote.index('printf'):]
        order = [request.index(token) for token in ('TWDEPLOY/2', 'deploy', '"$DIGEST"', '"$RELEASE_SHA"',
                                                     '"$RELEASE_TREE"', '"$MIGRATIONS_AGGREGATE"',
                                                     '"$MIGRATIONS_COUNT"', '"$REGISTRY_TOKEN"')]
        self.assertEqual(order, sorted(order))
        for forbidden in ('echo "$REGISTRY_TOKEN"', 'set -x', 'printenv', 'env |', 'eval ', 'bash -c', ' -o LogLevel=DEBUG'):
            self.assertNotIn(forbidden, remote)


if __name__ == '__main__':
    unittest.main()
