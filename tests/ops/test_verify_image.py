import json, unittest

from tests.ops.hostfixture import COMMIT, DIGEST, Host


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


class VerifyImageDenialTests(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.host.good_image()

    def fake(self, name, text):
        (self.host.ops.fake / name).write_bytes(text.encode())

    def drop_from_image(self, path):
        lines = (self.host.ops.fake / 'fs.txt').read_bytes().decode().splitlines()
        self.fake('fs.txt', chr(10).join(l for l in lines if l != path) + chr(10))

    def add_to_image(self, path):
        self.fake('fs.txt', (self.host.ops.fake / 'fs.txt').read_bytes().decode() + path + chr(10))

    def env_add(self, name, variable):
        path = self.host.ops.env_dir / name
        path.write_bytes(path.read_bytes() + (variable + '=TEST-ONLY' + chr(10)).encode())

    def denied(self, code, **kwargs):
        result = self.host.verify_image(**kwargs)
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertEqual(result.stdout, '')
        for forbidden in ('stop', 'rename', 'start', 'login', 'pull', 'rm', 'network'):
            self.assertFalse([a for a in docker_calls(result) if a[0] == forbidden], forbidden)
        result.assert_no_tripwire()
        self.assertNotIn('TEST-ONLY', result.stderr)

    def test_image_that_is_not_the_arm_linux_build_of_the_release_commit_is_74(self):
        self.fake('inspect', 'amd64|linux|' + COMMIT + chr(10))
        self.denied(74)
        self.fake('inspect', 'arm64|windows|' + COMMIT + chr(10))
        self.denied(74)
        self.fake('inspect', 'arm64|linux|' + 'f' * 40 + chr(10))
        self.denied(74)
        self.fake('inspect', 'arm64|linux|' + chr(10))
        self.denied(74)
        (self.host.ops.fake / 'inspect.rc').write_bytes(b'1')
        self.denied(74)

    def test_image_without_its_three_entrypoint_files_is_74(self):
        for path in ('/app/server.js', '/tools/scripts/email-worker.ts', '/tools/scripts/migration/migrate.ts'):
            with self.subTest(path=path):
                self.host.good_image()
                self.drop_from_image(path)
                self.denied(74)

    def test_migrations_that_differ_from_the_candidate_are_72(self):
        self.denied(72, aggregate='f' * 64)
        self.denied(72, count='99')

    def test_sqlite_fallback_in_the_image_is_76(self):
        self.add_to_image('/app/node_modules/better-sqlite3')
        self.denied(76)
        self.host.good_image()
        self.add_to_image('/tools/node_modules/better-sqlite3/lib')
        self.denied(76)
        self.host.good_image()
        self.fake('grep.rc', '0')
        self.denied(76)

    def test_env_files_must_keep_credentials_separate_by_name_only(self):
        for name, variable in (('web.env', 'MIGRATION_DATABASE_URL'), ('web.env', 'MAILER_DATABASE_URL'),
                               ('mailer.env', 'MIGRATION_DATABASE_URL')):
            with self.subTest(file=name, variable=variable):
                self.host = Host(self)
                self.host.good_image()
                self.env_add(name, variable)
                self.denied(74)
        self.host = Host(self)
        self.host.good_image()
        (self.host.ops.env_dir / 'web.env').unlink()
        self.denied(74)

    def test_arguments_must_be_a_digest_pinned_ref_commit_and_hex_identities(self):
        self.denied(64, ref='ghcr.io/dellanio/tech-woman:latest')
        self.denied(64, ref='ghcr.io/other/app@' + DIGEST)
        self.denied(64, ref='ghcr.io/dellanio/tech-woman@sha256:abc')
        self.denied(64, commit='main')
        self.denied(64, aggregate='xyz')
        self.denied(64, count='-1')
        result = self.host.ops.run('', script='verify-image.sh', args=[])
        self.assertEqual(result.returncode, 64)


class VerifyImageLocalCiTests(unittest.TestCase):
    ID = 'sha256:' + '2' * 64

    def setUp(self):
        self.host = Host(self)
        self.host.good_image()

    def test_image_only_verifies_a_local_image_id_without_any_host_env_files(self):
        for name in ('web.env', 'mailer.env', 'migrator.env'):
            (self.host.ops.env_dir / name).unlink()
        result = self.host.verify_image(ref=self.ID, flags=['--image-only'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['checks'], ['platform', 'revision', 'entrypoints', 'migrations', 'no-sqlite'])
        for args in docker_calls(result):
            if args[0] == 'run':
                self.assertIn('none', args)

    def test_image_only_still_denies_a_bad_image_and_a_bare_id_needs_the_flag(self):
        (self.host.ops.fake / 'inspect').write_bytes(('amd64|linux|' + COMMIT + chr(10)).encode())
        self.assertEqual(self.host.verify_image(ref=self.ID, flags=['--image-only']).returncode, 74)
        self.host.good_image()
        self.assertEqual(self.host.verify_image(ref=self.ID).returncode, 64)
        self.assertEqual(self.host.verify_image(ref='latest', flags=['--image-only']).returncode, 64)
        self.assertEqual(self.host.verify_image(ref=self.ID, flags=['--image-only', '--image-only']).returncode, 64)


if __name__ == '__main__':
    unittest.main()
