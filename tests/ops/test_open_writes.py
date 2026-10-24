import json, re, unittest

from tests.ops import harness
from tests.ops.hostfixture import DIGEST, Host, ORIGINAL_IP

cutover = harness.load_ops_module('cutover')
IMAGE = 'ghcr.io/dellanio/tech-woman@' + DIGEST
BASELINE = {'participant': 3, 'enrollment': 2, 'match': 1, 'audit_event': 9, 'app_user': 4, 'audit_max_id': 9}


def docker(calls):
    return [c['args'] for c in calls if c['cmd'] == 'docker']


def option(args, name):
    return args[args.index(name) + 1]


class OpenWritesTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.db, self.writer = self.host.sqlite()
        self.addCleanup(self.writer.close)
        candidate, state = self.host.imported()
        state.transition('activated', '2026-10-23T12:00:00Z', activation={'digest': DIGEST, 'container': 'tech-woman-web-pg',
                                                                         'at': '2026-10-23T12:00:00Z'})
        state.transition('smoke_ok', '2026-10-23T12:00:00Z')
        self.candidate = candidate
        (self.host.ops.fake / 'node.out.1').write_bytes((json.dumps(BASELINE) + '\n').encode())

    def state(self):
        return cutover.State.load(self.host.state_dir, cutover.UNCHECKED)


class OpenWritesTests(OpenWritesTestCase):
    def test_baseline_first_then_traffic_moves_to_the_pg_web_and_only_then_the_mailer_starts(self):
        done = self.host.cutover('open-writes')
        self.assertEqual(done.returncode, 0, done.stderr)
        calls = docker(self.host.cutover_calls())
        names = [(a[0], a[1] if len(a) > 1 else '') for a in calls]
        order = [calls.index(next(a for a in calls if predicate(a))) for predicate in (
            lambda a: a[0] == 'run' and '--entrypoint' in a and option(a, '--entrypoint') == 'node' and '-e' in a,
            lambda a: a[:3] == ['rm', '-f', 'tech-woman'],
            lambda a: a[:2] == ['network', 'disconnect'],
            lambda a: a[:2] == ['network', 'connect'],
            lambda a: a[0] == 'rename' and a[1:] == ['tech-woman-web-pg', 'tech-woman'],
            lambda a: a[0] == 'run' and '-d' in a and option(a, '--name') == 'tech-woman-mailer',
            lambda a: a[0] == 'exec')]
        self.assertEqual(order, sorted(order), names)
        connect = next(a for a in calls if a[:2] == ['network', 'connect'])
        self.assertEqual(option(connect, '--ip'), ORIGINAL_IP)
        self.assertEqual(option(connect, '--alias'), 'app')
        self.assertEqual(connect[-2:], ['testnet', 'tech-woman-web-pg'])
        mailer = next(a for a in calls if a[0] == 'run' and '-d' in a)
        self.assertTrue(option(mailer, '--env-file').endswith('mailer.env'))
        self.assertEqual(mailer[mailer.index(IMAGE) + 1:], ['--import', 'tsx', 'scripts/email-worker.ts'])
        self.assertLessEqual(int(re.fullmatch(r'(\d+)m', option(mailer, '--memory')).group(1)), 512)
        baseline = next(a for a in calls if a[0] == 'run' and '-e' in a and '--rm' in a)
        self.assertTrue(option(baseline, '--env-file').endswith('migrator.env'))
        script = baseline[baseline.index('-e') + 1].lower()
        for write in ('insert', 'update', 'delete', 'create', 'drop', 'alter', 'truncate'):
            self.assertNotIn(write, script)
        self.assertEqual([a for a in calls if a[0] in ('stop', 'start')], [])

    def test_state_records_the_baseline_the_known_pg_image_and_the_schema(self):
        self.assertEqual(self.host.cutover('open-writes').returncode, 0)
        state = self.state()
        self.assertEqual(state.phase, 'pg_write_open')
        self.assertEqual(state.data['known_pg_images'], [DIGEST])
        self.assertEqual(state.data['last_good_pg_image'], DIGEST)
        self.assertEqual(state.data['schema_migrations'], {'aggregate_sha256': self.candidate['migrations']['aggregate_sha256']})
        self.assertEqual(state.data['first_pg_write']['baseline'], BASELINE)
        self.assertIsNone(state.data['first_pg_write']['at'])

    def test_bad_baseline_or_wrong_phase_leaves_the_maintenance_page_in_place(self):
        (self.host.ops.fake / 'node.out.1').write_bytes(b'{"participant": "three"}\n')
        done = self.host.cutover('open-writes')
        self.assertEqual(done.returncode, 82, done.stderr)
        self.assertEqual(self.state().phase, 'smoke_ok')
        self.assertEqual([a for a in docker(self.host.cutover_calls()) if a[0] in ('rm', 'rename', 'network')], [])
        state = self.state()
        state.transition('recovering', '2026-10-23T12:00:00Z')
        self.assertEqual(self.host.cutover('open-writes').returncode, 75)

    def test_a_failed_switch_keeps_the_phase_and_never_touches_the_sqlite_original(self):
        (self.host.ops.fake / 'rename.rc').write_bytes(b'1')
        done = self.host.cutover('open-writes')
        self.assertEqual(done.returncode, 83, done.stderr)
        self.assertEqual(self.state().phase, 'smoke_ok')
        self.assertNotIn('tech-woman-sqlite-original', [x for a in docker(self.host.cutover_calls()) for x in a])


if __name__ == '__main__':
    unittest.main()
