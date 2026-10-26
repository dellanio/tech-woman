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
        self.assertIn('python3 ops/manifest.py ops-package-sha ops', probe)
        self.assertIn('package_sha256', probe)
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
        for required in ('RUN_ID: ${{ github.event.workflow_run.id }}', 'actions/runs/$RUN_ID',
                         '.path == ".github/workflows/approved-merge.yml"', '.event == "workflow_run"',
                         '.conclusion == "success"', '.repository.full_name == env.GH_REPO',
                         'event=pull_request', '.path == ".github/workflows/ci.yml"', '.head_sha == env.PR_HEAD',
                         '^[0-9a-f]{40}$'):
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


class StageAndPolicyTests(unittest.TestCase):
    def base_workflow(self):
        return subprocess.run(['git', 'show', '2ff7347a927458710c1789bb7ad52928f3f68e6c:.github/workflows/deploy.yml'], cwd=ROOT, capture_output=True,
                              check=True).stdout.decode().replace(chr(13) + chr(10), chr(10))

    def test_public_smoke_runs_only_after_a_release_never_after_a_stage(self):
        text = workflow()
        smoke = step(text, 'Public smoke after a release')
        self.assertIn("if: steps.remote.outputs.kind == 'release'", smoke)
        self.assertEqual(text.count('https://tech-woman.dellanio.com/'), 1)
        self.assertEqual(step_index(text, 'name: Public smoke after a release'), len(step_blocks(text)) - 1)

    def test_no_new_secret_no_wider_permission_and_action_pins_unchanged(self):
        text, base = workflow(), self.base_workflow()
        secrets = lambda t: sorted(set(re.findall(r'secrets\.([A-Z0-9_]+)', t)))
        self.assertEqual(secrets(text), secrets(base))
        self.assertEqual(sorted(set(re.findall(r'uses: (\S+@[0-9a-f]{40})', text))),
                         sorted(set(re.findall(r'uses: (\S+@[0-9a-f]{40})', base))))
        deploy_permissions = text.split('  deploy:\n', 1)[1].split('    steps:\n', 1)[0]
        permissions = re.findall(r'^      (\w[\w-]*): (\w+)$', deploy_permissions.split('permissions:\n', 1)[1], re.M)
        self.assertEqual(sorted(permissions), [('contents', 'read'), ('packages', 'write'), ('pull-requests', 'read')])

    def test_authorship_and_merge_policy_strings_are_preserved_and_unsafe_ones_absent(self):
        text = workflow()
        for kept in ('ref: main', 'group: production-tech-woman', "needs.gate.outputs.deploy == 'true'",
                     '.name == "merge" and .conclusion == "success"', 'workflows: [Beatriz auto-merge]',
                     'environment: production', 'persist-credentials: false'):
            self.assertIn(kept, text)
        for forbidden in ('workflow_run.head_sha', 'pull_request_target', '--auto', 'eval ', 'bash -c', 'set -x',
                          'github.event.pull_request', 'github.head_ref', '${{ github.event.workflow_run.head_branch }}'):
            self.assertNotIn(forbidden, text)
        # every ${{ }} placed inside a run block must come through env, never be spliced into shell source
        for name in ('Resolve immutable release', 'Verify the merged pull request result', 'Stage or release',
                     'Probe installed deploy package', 'Install deploy key', 'Confirm main has not advanced'):
            self.assertNotIn('${{', run_block(text, name), name)


if __name__ == '__main__':
    unittest.main()
