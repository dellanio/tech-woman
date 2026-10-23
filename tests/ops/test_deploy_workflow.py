import pathlib, re, subprocess, unittest

from tests.ops import harness

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


def run_block(text, name):
    """The shell of one workflow step, de-indented, exactly as the runner would execute it."""
    block = step(text, name)
    body = block.split('        run: |\n', 1)[1]
    lines = []
    for line in body.split('\n'):
        if line.strip() and not line.startswith('          '):
            break
        lines.append(line[10:])
    return '\n'.join(lines) + '\n'


class MergeIdentityTests(unittest.TestCase):
    def test_merged_pr_result_and_main_race_are_checked_before_build_and_before_the_remote_call(self):
        text = workflow()
        verify = step(text, 'Verify the merged pull request result')
        self.assertIn("if: github.event_name == 'workflow_run'", verify)
        for required in ('merged_at != null', 'merge_commit_sha == env.RELEASE_SHA', '.user.login == "beatrizbenz"',
                         '.base.ref == "main"', 'commits/$RELEASE_SHA/pulls'):
            self.assertIn(required, verify)
        order = [step_index(text, m) for m in ('name: Resolve immutable release',
                                               'name: Verify the merged pull request result',
                                               'name: Probe installed deploy package', 'docker/build-push-action',
                                               'name: Confirm main has not advanced', 'name: Stage or release')]
        self.assertEqual(order, sorted(order))
        self.assertIn('--expect "$PUSHED_SHA"', step(text, 'Resolve immutable release'))

    def test_the_resolve_step_shell_aborts_when_main_advanced_and_accepts_a_squash(self):
        import os, shutil, tempfile
        from tests.ops.test_manifest import git, write
        script = run_block(workflow(), 'Resolve immutable release')
        with tempfile.TemporaryDirectory() as tmp:
            repo = pathlib.Path(tmp) / 'repo'
            (repo / 'ops').mkdir(parents=True)
            (repo / 'drizzle').mkdir()
            shutil.copy(ROOT / 'ops/manifest.py', repo / 'ops/manifest.py')
            write(repo / 'drizzle/20260101000000_a.sql', b'select 1;\n')
            git(repo, 'init', '-q', '-b', 'main')
            git(repo, 'add', '.')
            git(repo, 'commit', '-q', '-m', 'one')
            first = git(repo, 'rev-parse', 'HEAD')
            write(repo / 'later.txt', b'x\n')
            git(repo, 'add', '.')
            git(repo, 'commit', '-q', '-m', 'two')
            second = git(repo, 'rev-parse', 'HEAD')

            def run(event, pushed):
                out = pathlib.Path(tmp) / 'out'
                out.write_bytes(b'')
                done = subprocess.run([harness.BASH, '-c', script], cwd=repo, capture_output=True, text=True,
                                      env=dict(os.environ, EVENT=event, PUSHED_SHA=pushed, GITHUB_OUTPUT=str(out)))
                return done, out.read_bytes().decode()

            ok, output = run('push', second)
            self.assertEqual(ok.returncode, 0, ok.stderr)
            self.assertIn('sha=' + second, output)
            self.assertIn('tree=' + git(repo, 'rev-parse', 'HEAD^{tree}'), output)
            self.assertIn('migrations_count=1', output)
            advanced, output = run('push', first)
            self.assertEqual(advanced.returncode, 71, advanced.stderr)
            self.assertEqual(output, '')
            relay, output = run('workflow_run', first)
            self.assertEqual(relay.returncode, 0, relay.stderr)
            self.assertIn('sha=' + second, output)


if __name__ == '__main__':
    unittest.main()
