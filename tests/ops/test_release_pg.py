import json, os, re, unittest

from tests.ops.hostfixture import DIGEST, Host, OLD_PG_DIGEST, OLD_PG_IMAGE, ORIGINAL_IP, SECRET

NEW_IMAGE = 'ghcr.io/dellanio/tech-woman@' + DIGEST
SQLITE_NAMES = ('tech-woman-sqlite-original',)


def docker(result):
    return [c['args'] for c in result.calls() if c['cmd'] == 'docker']


def option(args, name):
    return args[args.index(name) + 1]


def index_of(calls, predicate):
    return next(i for i, a in enumerate(calls) if predicate(a))


class ReleaseTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.host.pg_open()
        self.host.good_image()

    def release(self, **changes):
        return self.host.deploy(**changes)

    def assert_denied_before_effect(self, result, code):
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertEqual(result.stdout, '')
        for args in docker(result):
            self.assertNotIn(args[0], ('stop', 'rename', 'start', 'rm', 'network'))
            self.assertFalse(args[0] == 'run' and '-d' in args)
        result.assert_no_tripwire()
        self.assertNotIn(SECRET, result.stderr)


class ReleaseHappyPathTests(ReleaseTestCase):
    def test_release_backs_up_swaps_the_web_in_place_checks_it_and_only_then_restarts_the_mailer(self):
        result = self.release()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual((report['op'], report['release']), ('release', 'verified'))
        calls = docker(result)
        order = [index_of(calls, p) for p in (
            lambda a: 'login' in a,
            lambda a: 'pull' in a,
            lambda a: a[:2] == ['image', 'inspect'],
            lambda a: a[:2] == ['inspect', 'tech-woman'],
            lambda a: a[0] == 'exec' and 'pg_dump' in a,
            lambda a: a[:2] == ['stop', 'tech-woman-mailer'],
            lambda a: a[0] == 'rename' and a[1] == 'tech-woman' and a[2].startswith('tech-woman-previous-'),
            lambda a: a[0] == 'run' and '-d' in a and option(a, '--name') == 'tech-woman',
            lambda a: a[0] == 'exec' and 'pg_dump' not in a,
            lambda a: a[0] == 'run' and '-d' in a and option(a, '--name') == 'tech-woman-mailer')]
        self.assertEqual(order, sorted(order))
        web = next(a for a in calls if a[0] == 'run' and '-d' in a and option(a, '--name') == 'tech-woman')
        self.assertEqual(option(web, '--ip'), ORIGINAL_IP)
        self.assertEqual(option(web, '--network-alias'), 'app')
        self.assertEqual(option(web, '--network'), 'testnet')
        self.assertTrue(option(web, '--env-file').endswith('web.env'))
        self.assertEqual((option(web, '--memory'), option(web, '--cpus')), ('384m', '0.5'))
        self.assertEqual(web[web.index('--log-opt'):web.index('--log-opt') + 4],
                         ['--log-opt', 'max-size=10m', '--log-opt', 'max-file=3'])
        self.assertEqual(web[-1], NEW_IMAGE)
        mailer = next(a for a in calls if a[0] == 'run' and '-d' in a and option(a, '--name') == 'tech-woman-mailer')
        self.assertTrue(option(mailer, '--env-file').endswith('mailer.env'))
        self.assertLessEqual(int(re.fullmatch(r'(\d+)m', option(mailer, '--memory')).group(1)), 512)
        dumps = list((self.host.ops.host / 'backups').glob('pre-release-*.dump'))
        self.assertEqual(len(dumps), 1)
        self.assertGreater(dumps[0].stat().st_size, 0)
        dump = next(a for a in calls if a[0] == 'exec' and 'pg_dump' in a)
        self.assertEqual(dump[1:], ['test-postgres', 'pg_dump', '-Fc', '-U', 'backup_techwoman', 'techwoman'])
        self.assertNotIn(SECRET, result.stdout + result.stderr + json.dumps(result.calls()))
        self.assertEqual([x for a in calls for x in a if x in SQLITE_NAMES], [])
        result.assert_no_tripwire()


class ReleaseDenialTests(ReleaseTestCase):
    def test_a_failed_or_empty_backup_is_79_and_nothing_was_touched(self):
        (self.host.ops.fake / 'pgdump.rc').write_bytes(b'1')
        self.assert_denied_before_effect(self.release(), 79)
        (self.host.ops.fake / 'pgdump.rc').unlink()
        (self.host.ops.fake / 'dump.bytes').write_bytes(b'')
        self.assert_denied_before_effect(self.release(), 79)

    def test_schema_change_or_unattested_image_is_denied_before_any_effect(self):
        self.setUp()
        self.host = Host(self)
        self.host.pg_open(schema_aggregate='f' * 64)
        self.host.good_image()
        self.assert_denied_before_effect(self.release(), 72)
        self.host = Host(self)
        self.host.pg_open()
        (self.host.ops.fake / 'inspect').write_bytes(('amd64|linux|' + 'a' * 40 + '\n').encode())
        self.assert_denied_before_effect(self.release(), 74)

    def test_a_running_web_that_is_not_a_known_pg_image_is_76_and_is_never_restarted_or_renamed(self):
        for running in ('ghcr.io/dellanio/tech-woman@sha256:' + '0' * 64, 'tech-woman:latest', 'ghcr.io/dellanio/tech-woman@sha256:' + 'b' * 64):
            with self.subTest(running=running):
                self.host = Host(self)
                self.host.pg_open()
                self.host.good_image()
                (self.host.ops.fake / 'container-inspect').write_bytes((running + '|' + ORIGINAL_IP + '\n').encode())
                self.assert_denied_before_effect(self.release(), 76)


class MailerDrainTests(ReleaseTestCase):
    """Review: the mailer must be PROVEN stopped before the web is swapped; no failure is ignored."""

    def test_a_mailer_that_is_not_proven_stopped_stops_the_release_before_the_web_is_touched(self):
        cases = {'stop fails': ('stop.tech-woman-mailer.rc', b'1'),
                 'still running after stop': ('inspect.tech-woman-mailer', b'true'),
                 'state unknown': ('inspect.tech-woman-mailer.rc', b'1')}
        for name, (file, content) in cases.items():
            with self.subTest(name=name):
                self.setUp()
                (self.host.ops.fake / file).write_bytes(content)
                result = self.release()
                self.assertEqual(result.returncode, 77, result.stderr)
                self.assertIn('mailer', result.stderr)
                calls = docker(result)
                self.assertEqual([a for a in calls if a[0] in ('rename', 'rm') or a == ['stop', 'tech-woman']
                                  or (a[0] == 'run' and '-d' in a)], [])
                self.assertEqual(result.stdout, '')

    def test_a_mailer_that_cannot_be_set_aside_after_the_release_is_reported(self):
        (self.host.ops.fake / 'rename.tech-woman-mailer.rc').write_bytes(b'1')
        result = self.release()
        self.assertEqual(result.returncode, 77, result.stderr)
        self.assertIn('mailer', result.stderr)
        self.assertEqual([a for a in docker(result) if a[0] == 'run' and '-d' in a and 'tech-woman-mailer' in a], [])


class LastGoodIdentityTests(ReleaseTestCase):
    def test_a_known_pg_web_that_is_not_the_last_good_one_is_76_before_any_effect(self):
        other = 'sha256:' + 'c' * 64
        self.host = Host(self)
        self.host.pg_open(known=(OLD_PG_DIGEST, other))
        self.host.good_image()
        (self.host.ops.fake / 'container-inspect').write_bytes(
            ('ghcr.io/dellanio/tech-woman@%s|%s' % (other, ORIGINAL_IP) + chr(10)).encode())
        self.assert_denied_before_effect(self.release(), 76)


class ReleaseRollbackTests(ReleaseTestCase):
    def new_web_fails_restored_passes(self):
        fake = self.host.ops.fake
        for n in (1, 2):  # TW_SMOKE_ATTEMPTS=2 for the new web
            (fake / ('exec-tech-woman.rc.%d' % n)).write_bytes(b'1')
        (fake / 'exec-tech-woman.rc.3').write_bytes(b'0')

    def test_rollback_is_verified_before_it_is_reported(self):
        self.new_web_fails_restored_passes()
        result = self.release()
        self.assertEqual(result.returncode, 77, result.stderr)
        calls = docker(result)
        after = calls[index_of(calls, lambda a: a[:3] == ['rm', '-f', 'tech-woman']):]
        steps = [a[:2] if a[0] == 'exec' else a for a in after]
        self.assertEqual(steps[0], ['rm', '-f', 'tech-woman'])
        self.assertEqual(steps[2:5], [['start', 'tech-woman'], ['exec', 'tech-woman'], ['start', 'tech-woman-mailer']])
        self.assertIn('answers', result.stderr)

    def test_a_rollback_that_does_not_come_back_keeps_maintenance_and_says_not_restored_84(self):
        cases = {'restored web fails its smoke': ('exec.rc', b'1'),
                 'previous container cannot take the name': ('rename.rc.2', b'1'),
                 'previous container does not start': ('start.tech-woman.rc', b'1')}
        for name, (file, content) in cases.items():
            with self.subTest(name=name):
                self.setUp()
                self.new_web_fails_restored_passes()  # the new web always fails; the case decides the rollback
                if file == 'exec.rc':
                    (self.host.ops.fake / 'exec-tech-woman.rc.3').unlink()
                (self.host.ops.fake / file).write_bytes(content)
                result = self.release()
                self.assertEqual(result.returncode, 84, result.stderr)
                self.assertIn('NOT restored', result.stderr)
                calls = docker(result)
                after = calls[index_of(calls, lambda a: a[:3] == ['rm', '-f', 'tech-woman']):]
                self.assertTrue(any(a[0] == 'run' and '-d' in a and option(a, '--name') == 'tech-woman'
                                    and '503' in a[a.index('-e') + 1] for a in after), name)
                self.assertEqual([x for a in calls for x in a if x in SQLITE_NAMES], [])

    def test_a_mailer_that_does_not_restart_after_a_rollback_is_not_hidden(self):
        self.new_web_fails_restored_passes()
        (self.host.ops.fake / 'start.tech-woman-mailer.rc').write_bytes(b'1')
        result = self.release()
        self.assertEqual(result.returncode, 84, result.stderr)
        self.assertIn('mailer', result.stderr)

    def test_smoke_failure_restarts_only_the_last_good_pg_container_and_exits_77(self):
        self.new_web_fails_restored_passes()
        result = self.release()
        self.assertEqual(result.returncode, 77, result.stderr)
        self.assertEqual(result.stdout, '')
        calls = docker(result)
        rollback = calls[index_of(calls, lambda a: a[:3] == ['rm', '-f', 'tech-woman']):]
        self.assertEqual(rollback[0], ['rm', '-f', 'tech-woman'])
        self.assertEqual(rollback[1][0], 'rename')
        self.assertTrue(rollback[1][1].startswith('tech-woman-previous-'))
        self.assertEqual(rollback[1][2], 'tech-woman')
        self.assertEqual(rollback[2], ['start', 'tech-woman'])
        self.assertIn(['start', 'tech-woman-mailer'], rollback)
        self.assertEqual([a for a in calls if a[0] == 'run' and '-d' in a and 'tech-woman-mailer' in a], [])
        self.assertEqual([x for a in calls for x in a if x in SQLITE_NAMES], [])

    def test_without_a_last_good_image_a_failed_smoke_keeps_the_maintenance_page_and_exits_77(self):
        self.host = Host(self)
        self.host.pg_open(last_good=None)
        self.host.good_image()
        (self.host.ops.fake / 'exec.rc').write_bytes(b'1')
        result = self.release()
        self.assertEqual(result.returncode, 77, result.stderr)
        calls = docker(result)
        failed = index_of(calls, lambda a: a[:3] == ['rm', '-f', 'tech-woman'])
        after = calls[failed:]
        maintenance = next(a for a in after if a[0] == 'run' and '-d' in a)
        self.assertEqual((option(maintenance, '--name'), option(maintenance, '--ip'), option(maintenance, '--network-alias')),
                         ('tech-woman', ORIGINAL_IP, 'app'))
        self.assertIn('503', maintenance[maintenance.index('-e') + 1])
        self.assertEqual([a for a in after if a[0] in ('start', 'rename')], [])
        self.assertEqual([x for a in calls for x in a if x in SQLITE_NAMES], [])


if __name__ == '__main__':
    unittest.main()
