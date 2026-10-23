import hashlib, os, re, unittest

from tests.ops import harness
from tests.ops.hostfixture import DIGEST, Host, ORIGINAL_IMAGE

cutover = harness.load_ops_module('cutover')
IMAGE = 'ghcr.io/dellanio/tech-woman@' + DIGEST
RESTORE = [['rm', '-f', 'tech-woman'], ['rename', 'tech-woman-sqlite-original', 'tech-woman'], ['start', 'tech-woman']]


def docker(calls):
    return [c['args'] for c in calls if c['cmd'] == 'docker']


def option(args, name):
    return args[args.index(name) + 1]


def megabytes(text):
    return int(re.fullmatch(r'(\d+)m', text).group(1))


class ActivateTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.db, self.writer = self.host.sqlite()
        self.addCleanup(self.writer.close)
        self.host.imported()
        (self.host.ops.fake / 'node.out.1').write_bytes(b'Migrations aplicadas.\n')

    def state(self):
        return cutover.State.load(self.host.state_dir, cutover.UNCHECKED)


class ActivateTests(ActivateTestCase):
    def test_activate_runs_the_migrator_then_starts_only_the_web_beside_the_maintenance_page(self):
        done = self.host.cutover('activate')
        self.assertEqual(done.returncode, 0, done.stderr)
        state = self.state()
        self.assertEqual(state.phase, 'activated')
        self.assertEqual((state.data['activation']['digest'], state.data['activation']['container']),
                         (DIGEST, 'tech-woman-web-pg'))
        calls = docker(self.host.cutover_calls())
        runs = [a for a in calls if a[0] == 'run']
        self.assertEqual(len(runs), 2)
        migrator, web = runs
        self.assertTrue(option(migrator, '--env-file').endswith('migrator.env'))
        self.assertEqual(migrator[migrator.index(IMAGE) + 1:], ['--import', 'tsx', 'scripts/migration/migrate.ts'])
        self.assertTrue(option(web, '--env-file').endswith('web.env'))
        self.assertEqual(option(web, '--name'), 'tech-woman-web-pg')
        self.assertEqual(web[-1], IMAGE)
        # internal only: no public IP/alias yet, the maintenance page keeps answering 503
        for forbidden in ('--ip', '--network-alias'):
            self.assertNotIn(forbidden, web)
        for args in runs:
            self.assertLessEqual(megabytes(option(args, '--memory')), 512)
            self.assertIn('--cpus', args)
            self.assertEqual(option(args, '--log-opt'), 'max-size=10m')
            self.assertEqual(option(args, '--network'), 'testnet')
        self.assertEqual([a for a in calls if a[0] in ('stop', 'rename', 'rm', 'start')], [])
        self.assertNotIn(ORIGINAL_IMAGE, [x for a in calls for x in a])

    def test_failures_before_the_state_change_abort_to_the_original_sqlite_service(self):
        for name, files in {'migrator exits 1': {'node.rc.1': b'1'}, 'web does not start': {'run-d.rc': b'1'}}.items():
            with self.subTest(name=name):
                self.setUp()
                for file, content in files.items():
                    (self.host.ops.fake / file).write_bytes(content)
                done = self.host.cutover('activate')
                self.assertEqual(done.returncode, 77, done.stderr)
                self.assertEqual(self.state().phase, 'aborted_pre_write')
                self.assertEqual(docker(self.host.cutover_calls())[-3:], RESTORE)
                self.assertTrue((os.stat(self.db).st_mode & 0o200 != 0))

    def test_activate_needs_the_imported_phase_and_a_valid_window(self):
        self.state().transition('activated', '2026-10-23T12:00:00Z')
        self.assertEqual(self.host.cutover('activate').returncode, 75)
        self.assertEqual(docker(self.host.cutover_calls()), [])


class SmokeTests(ActivateTestCase):
    def test_smoke_is_one_read_only_request_inside_the_web_container(self):
        self.assertEqual(self.host.cutover('activate').returncode, 0)
        before = len(self.host.cutover_calls())
        done = self.host.cutover('smoke')
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.state().phase, 'smoke_ok')
        calls = docker(self.host.cutover_calls()[before:])
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0][:2], ['exec', 'tech-woman-web-pg'])
        script = calls[0][calls[0].index('-e') + 1]
        self.assertIn('http://127.0.0.1:3000/', script)
        for write in ('POST', 'PUT', 'PATCH', 'DELETE', 'method'):
            self.assertNotIn(write, script)

    def test_failed_smoke_never_goes_back_to_sqlite(self):
        self.assertEqual(self.host.cutover('activate').returncode, 0)
        (self.host.ops.fake / 'exec.rc').write_bytes(b'1')
        done = self.host.cutover('smoke')
        self.assertEqual(done.returncode, 77, done.stderr)
        self.assertEqual(self.state().phase, 'activated')
        self.assertEqual([a for a in docker(self.host.cutover_calls()) if a[0] in ('rm', 'rename', 'start', 'stop')], [])


if __name__ == '__main__':
    unittest.main()
