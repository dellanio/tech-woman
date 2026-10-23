import hashlib, json, os, unittest

from tests.ops import harness
from tests.ops.hostfixture import DIGEST, Host

cutover = harness.load_ops_module('cutover')
RUN_ID = '3f2b8c1e-5a6d-4e7f-9a10-b2c3d4e5f607'
GOOD_FIRST = {'dryRun': False, 'idempotent': False, 'runId': RUN_ID, 'status': 'imported', 'issues': 0,
              'counts': {'participants': 2}}
GOOD_SECOND = dict(GOOD_FIRST, idempotent=True)
RESTORE = [['rm', '-f', 'tech-woman'], ['rename', 'tech-woman-sqlite-original', 'tech-woman'], ['start', 'tech-woman']]


def docker(calls):
    return [c['args'] for c in calls if c['cmd'] == 'docker']


class ImportTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.db, self.writer = self.host.sqlite()
        self.addCleanup(self.writer.close)
        self.host.snapshotted()
        self.source_hash = hashlib.sha256(self.db.read_bytes()).hexdigest()

    def state(self):
        return cutover.State.load(self.host.state_dir, cutover.UNCHECKED)

    def importer_says(self, first, second=None, rc1=0, rc2=0):
        fake = self.host.ops.fake
        (fake / 'node.count').unlink(missing_ok=True)
        (fake / 'node.out.1').write_bytes(b'Migrations aplicadas.' + bytes([10]))
        for n, (out, rc) in enumerate(((first, rc1), (second, rc2)), start=2):
            if out is not None:
                (fake / ('node.out.%d' % n)).write_bytes((out if isinstance(out, str) else json.dumps(out)).encode() + b'\n')
            (fake / ('node.rc.%d' % n)).write_bytes(str(rc).encode())

    def assert_aborted_before_any_write(self, done):
        self.assertEqual(done.returncode, 82, done.stderr)
        state = self.state()
        self.assertEqual(state.phase, 'aborted_pre_write')
        self.assertTrue(state.data['abort']['reason'])
        self.assertEqual(docker(self.host.cutover_calls())[-3:], RESTORE)
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), self.source_hash)
        self.assertTrue(os.access(self.db, os.W_OK))
        self.assertTrue((self.host.state_dir / 'private' / '4-B.db').exists())


class ImportVerifyTests(ImportTestCase):
    def test_importer_report_is_checked_twice_and_the_second_run_proves_the_source_checksum(self):
        self.importer_says(GOOD_FIRST, GOOD_SECOND)
        done = self.host.cutover('import-verify')
        self.assertEqual(done.returncode, 0, done.stderr)
        state = self.state()
        self.assertEqual(state.phase, 'imported')
        record = state.data['import']
        self.assertEqual((record['report_pass'], record['run_id'], record['source_checksum']),
                         (True, RUN_ID, state.data['snapshot']['sha256']))
        runs = [a for a in docker(self.host.cutover_calls()) if a[0] == 'run']
        self.assertEqual(len(runs), 3)  # migrate (idempotent), import, import again
        migrate_args = runs[0]
        self.assertEqual(migrate_args[migrate_args.index('--entrypoint') + 1], 'node')
        self.assertEqual(migrate_args[migrate_args.index('ghcr.io/dellanio/tech-woman@' + DIGEST) + 1:],
                         ['--import', 'tsx', 'scripts/migration/migrate.ts'])
        for args in runs[1:]:
            self.assertEqual(args[args.index('--network') + 1], 'testnet')
            self.assertTrue(args[args.index('--env-file') + 1].endswith('migrator.env'))
            self.assertEqual(args[args.index('--entrypoint') + 1], 'node')
            self.assertIn('ghcr.io/dellanio/tech-woman@' + DIGEST, args)
            self.assertIn('--rm', args)
            tail = args[args.index('ghcr.io/dellanio/tech-woman@' + DIGEST) + 1:]
            self.assertEqual(tail, ['--import', 'tsx', 'scripts/migration/import.ts', '/snapshot/4-B.db'])
            mount = args[args.index('--mount') + 1]
            self.assertIn('dst=/snapshot', mount)
            self.assertIn('readonly', mount)
            self.assertEqual(args[args.index('--workdir') + 1], '/tools')
        self.assertNotIn('TEST-ONLY', done.stdout + done.stderr)
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), self.source_hash)

    def test_every_deviation_aborts_before_any_write_and_restores_the_original_service(self):
        cases = {
            'pending with issues': (dict(GOOD_FIRST, status='pending', issues=3), GOOD_SECOND, 0, 0),
            'not imported status': (dict(GOOD_FIRST, status='failed'), GOOD_SECOND, 0, 0),
            'dry run report': (dict(GOOD_FIRST, dryRun=True), GOOD_SECOND, 0, 0),
            'first run claims idempotent': (dict(GOOD_FIRST, idempotent=True), GOOD_SECOND, 0, 0),
            'second run not idempotent': (GOOD_FIRST, dict(GOOD_FIRST), 0, 0),
            'second run other run id': (GOOD_FIRST, dict(GOOD_SECOND, runId='aaaaaaaa-5a6d-4e7f-9a10-b2c3d4e5f607'), 0, 0),
            'unknown report field': (dict(GOOD_FIRST, surprise=1), GOOD_SECOND, 0, 0),
            'issues is bool': (dict(GOOD_FIRST, issues=False), GOOD_SECOND, 0, 0),
            'not json': ('importer exploded', GOOD_SECOND, 0, 0),
            'importer exit 1': (None, None, 1, 0),
            'second importer exit 1': (GOOD_FIRST, None, 0, 1),
        }
        for name, (first, second, rc1, rc2) in cases.items():
            with self.subTest(name=name):
                self.setUp()
                self.importer_says(first, second, rc1, rc2)
                self.assert_aborted_before_any_write(self.host.cutover('import-verify'))


class AbortTests(ImportTestCase):
    def test_operator_abort_restores_service_and_keeps_the_source_and_snapshots(self):
        done = self.host.cutover('abort', '--reason', 'operator-decision')
        self.assertEqual(done.returncode, 0, done.stderr)
        state = self.state()
        self.assertEqual((state.phase, state.data['abort']['reason']), ('aborted_pre_write', 'operator-decision'))
        self.assertEqual(docker(self.host.cutover_calls())[-3:], RESTORE)
        self.assertTrue(os.access(self.db, os.W_OK))
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), self.source_hash)
        self.assertTrue((self.host.state_dir / 'private' / '4-A.db').exists())
        self.assertIn('chattr', [c['cmd'] for c in self.host.cutover_calls()])

    def test_abort_is_refused_once_the_stack_is_activated_and_for_unsafe_reasons(self):
        self.assertEqual(self.host.cutover('abort', '--reason', 'rm -rf /').returncode, 64)
        self.assertEqual(self.host.cutover('abort').returncode, 64)
        state = self.state()
        state.transition('imported', '2026-10-23T12:00:00Z', **{'import': {'report_pass': True}})
        state.transition('activated', '2026-10-23T12:00:00Z')
        done = self.host.cutover('abort', '--reason', 'too-late')
        self.assertEqual(done.returncode, 75, done.stderr)
        self.assertEqual(self.state().phase, 'activated')
        self.assertEqual([a for a in docker(self.host.cutover_calls()) if a[0] in ('rm', 'rename', 'start')], [])


if __name__ == '__main__':
    unittest.main()
