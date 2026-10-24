import pathlib, re, subprocess, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
CI_YML = ROOT / '.github/workflows/ci.yml'


def ci():
    return CI_YML.read_bytes().decode('utf-8').replace(chr(13) + chr(10), chr(10))  # parsing only


def base_ci():
    return subprocess.run(['git', 'show', 'aadb3cb:.github/workflows/ci.yml'], cwd=ROOT, capture_output=True,
                          check=True).stdout.decode().replace(chr(13) + chr(10), chr(10))


def steps(text):
    body = text.split('    steps:\n', 1)[1]
    return [part for part in re.split(r'\n      - ', '\n' + body) if part.strip()]


def position(text, needle):
    for index, block in enumerate(steps(text)):
        if needle in block:
            return index
    raise AssertionError('no CI step contains: %s' % needle)


class JobShapeTests(unittest.TestCase):
    def test_single_check_job_on_arm_with_a_real_postgres_16_service(self):
        text = ci()
        self.assertEqual(re.findall(r'^  (\w[\w-]*):$', text.split('jobs:\n', 1)[1], re.M), ['check'])
        self.assertIn('    name: check\n', text)
        self.assertIn('runs-on: ubuntu-24.04-arm', text)
        self.assertIn('timeout-minutes: 45', text)
        service = text.split('    services:\n', 1)[1].split('    steps:\n', 1)[0]
        self.assertIn('postgres:16', service)
        self.assertIn('--health-cmd', service)
        self.assertIn('pg_isready', service)
        self.assertIn('5432:5432', service)

    def test_nothing_can_make_a_failing_step_look_green(self):
        text = ci()
        for forbidden in ('continue-on-error', '|| true', '|| :', 'if: always()', 'if: failure()',
                          'pull_request_target', 'set +e', 'skip'):
            self.assertNotIn(forbidden, text)
        self.assertEqual(len(re.findall(r'^\s+if:', text, re.M)), 0)
        self.assertIn('permissions:\n  contents: read\n', text)

    def test_checks_and_pins_inherited_from_the_base_workflow_are_unchanged(self):
        text, base = ci(), base_ci()
        pins = lambda t: sorted(set(re.findall(r'uses: (\S+@[0-9a-f]{40})', t)))
        self.assertEqual(pins(text), pins(base))
        for kept in ('name: CI', 'pull_request:', 'branches: [main]', 'group: ci-${{ github.ref }}',
                     'cancel-in-progress: true', 'node-version: \'24\'', 'persist-credentials: false',
                     'corepack prepare pnpm@10.34.6 --activate'):
            self.assertIn(kept, text)


    def test_checkout_keeps_full_history_for_the_policy_diffs_against_the_base(self):
        # INT-006 (R-004): the policy tests run git show/diff against BASE; a shallow checkout (default depth 1) has no BASE.
        text = ci()
        checkout = steps(text)[position(text, "uses: actions/checkout@")]
        self.assertIn("fetch-depth: 0", checkout)


class StepOrderTests(unittest.TestCase):
    def test_password_hash_csrf_and_origin_unit_suite_is_not_lost_by_the_pg_glob(self):
        text = ci()
        unit = position(text, 'pnpm exec tsx --test tests/unit/password.test.ts')
        self.assertLess(position(text, 'pnpm install --frozen-lockfile'), unit)
        self.assertLess(unit, position(text, 'pnpm build'))

    def test_suites_run_in_the_documented_order_with_the_real_commands(self):
        text = ci()
        order = [position(text, needle) for needle in (
            'pnpm install --frozen-lockfile', 'python3 -m unittest discover -s tests -v', 'pnpm exec tsc --noEmit',
            'pnpm build', 'pnpm test:pg', 'pnpm exec tsx --test --test-concurrency=1 tests/ops/pg/*.test.ts',
            'pnpm exec playwright install --with-deps chromium', 'pnpm test:e2e', 'docker build',
            'ops/verify-image.sh', '$GITHUB_STEP_SUMMARY')]
        self.assertEqual(order, sorted(order))
        self.assertEqual(len(set(order)), 11)

    def test_build_runs_with_the_database_unreachable_and_pg_suites_use_the_service(self):
        text = ci()
        build = steps(text)[position(text, 'pnpm build')]
        self.assertIn("BUILDING: '1'", build)
        self.assertRegex(build, r"DATABASE_URL: postgresql://[^\n]*@127\.0\.0\.1:1/")
        for needle in ('pnpm test:pg', 'tests/ops/pg/*.test.ts', 'pnpm test:e2e'):
            block = steps(text)[position(text, needle)]
            self.assertRegex(block, r'MIGRATION_DATABASE_URL: postgresql://postgres:postgres@127\.0\.0\.1:5432/postgres')

    def test_ops_postgres_suites_run_on_their_own_disposable_cluster_with_real_commands(self):
        text = ci()
        install = position(text, 'apt-get install -y --no-install-recommends postgresql-16')
        python_pg = position(text, 'python3 -m unittest -v tests.ops.pg.test_recovery_pg tests.ops.pg.test_preflight_pg')
        ts_pg = position(text, 'tests/ops/pg/*.test.ts')
        self.assertLess(install, python_pg)
        self.assertLess(python_pg, ts_pg)
        self.assertLess(position(text, 'pnpm test:pg'), python_pg)
        for index in (python_pg, ts_pg):
            block = steps(text)[index]
            self.assertIn('WP005_PG_DATA: ${{ runner.temp }}/wp005-recovery-pg', block)
            self.assertIn("WP005_PG_PORT: '55346'", block)
            self.assertIn('PG_BIN: /usr/lib/postgresql/16/bin', block)
        self.assertNotIn('sudo -u postgres', text)  # the test cluster runs as the runner user, never as a system service

    def test_image_is_built_without_push_verified_and_the_facts_are_summarised(self):
        text = ci()
        image = steps(text)[position(text, 'docker build')]
        self.assertNotIn('push', image)
        self.assertIn('--platform linux/arm64', image)
        self.assertIn('--label org.opencontainers.image.revision=', image)
        verify = steps(text)[position(text, 'ops/verify-image.sh')]
        self.assertIn('python3 ops/manifest.py release-facts', verify)
        self.assertIn('--image-only', verify)
        self.assertNotIn('eval ', verify)
        summary = steps(text)[position(text, '$GITHUB_STEP_SUMMARY')]
        self.assertIn('release-facts', summary)


if __name__ == '__main__':
    unittest.main()
