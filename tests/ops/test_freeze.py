import hashlib, threading, time, unittest

from tests.ops import harness
from tests.ops.hostfixture import ORIGINAL_IMAGE, ORIGINAL_IP, Host

cutover = harness.load_ops_module('cutover')
MUTATING = ('stop', 'rename', 'rm', 'start', 'run')


def docker(calls):
    return [c['args'] for c in calls if c['cmd'] == 'docker']


def mutations(calls):
    return [a for a in docker(calls) if a[0] in MUTATING]


def base_name(path):
    return path.replace('\\', '/').rsplit('/', 1)[-1]


class FreezeTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.host.staged()
        self.db, self.writer = self.host.sqlite()
        self.addCleanup(self.writer.close)
        self.db_hash = hashlib.sha256(self.db.read_bytes()).hexdigest()

    def state(self):
        return cutover.State.load(self.host.state_dir, cutover.UNCHECKED)

    def freeze(self, seconds='1'):
        return self.host.cutover('freeze', '--quiet-seconds', seconds)

    def assert_unfrozen_and_available(self, done, code):
        self.assertEqual(done.returncode, code, done.stderr)
        self.assertEqual(self.state().phase, 'prepared')
        self.assertEqual(self.state().seq, 2)
        calls = mutations(self.host.cutover_calls())
        if calls:  # maintenance was raised, so the original must be back and running
            self.assertEqual(calls[-3:], [['rm', '-f', 'tech-woman'],
                                          ['rename', 'tech-woman-sqlite-original', 'tech-woman'],
                                          ['start', 'tech-woman']])


class FreezeHappyPathTests(FreezeTestCase):
    def test_freeze_raises_maintenance_in_place_confirms_every_writer_and_records_the_phase(self):
        done = self.freeze()
        self.assertEqual(done.returncode, 0, done.stderr)
        state = self.state()
        self.assertEqual((state.phase, state.seq), ('frozen', 3))
        freeze = state.data['freeze']
        self.assertEqual(freeze['writers_checked'], ['app-container', 'mailer-containers', 'timers', 'cron',
                                                     'file-handles', 'quiet-window'])
        self.assertEqual((freeze['quiet_seconds'], freeze['original_container'], freeze['original_image'], freeze['ip']),
                         (1, 'tech-woman-sqlite-original', ORIGINAL_IMAGE, ORIGINAL_IP))
        self.assertRegex(freeze['cutoff_at'], r'^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$')
        calls = self.host.cutover_calls()
        self.assertEqual(mutations(calls)[:2], [['stop', 'tech-woman'],
                                                ['rename', 'tech-woman', 'tech-woman-sqlite-original']])
        run = mutations(calls)[2]
        self.assertEqual(run[0], 'run')
        for flag, value in (('--name', 'tech-woman'), ('--network', 'testnet'), ('--ip', ORIGINAL_IP),
                            ('--network-alias', 'app'), ('--restart', 'unless-stopped'), ('--entrypoint', 'node')):
            self.assertEqual(run[run.index(flag) + 1], value, flag)
        self.assertIn('-d', run)
        self.assertIn(ORIGINAL_IMAGE, run)
        script = run[run.index('-e') + 1]
        self.assertIn('503', script)
        self.assertIn('Retry-After', script)
        self.assertEqual([m for m in mutations(calls) if m[0] in ('rm', 'start')], [])
        fuser = [c['args'] for c in calls if c['cmd'] == 'fuser'][0]
        self.assertEqual(fuser[0], '-v')
        self.assertEqual([base_name(p) for p in fuser[1:]], ['tech-woman.db', 'tech-woman.db-wal', 'tech-woman.db-shm'])
        self.assertNotIn('nginx', [c['cmd'] for c in calls])
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), self.db_hash)


class FreezeRefusalTests(FreezeTestCase):
    def test_any_remaining_writer_refuses_the_freeze_and_restores_the_original_service(self):
        arrangements = {
            'mailer container': ('ps', b'tech-woman\ntech-woman-mailer\n'),
            'job container': ('ps', b'tech-woman\ntech-woman-job-7\n'),
            'systemd timer': ('timers', b'Fri 12:00 5min tech-woman-backup.timer tech-woman-backup.service\n'),
            'cron entry': ('crontab', b'*/5 * * * * /usr/local/bin/tech-woman-sync\n'),
            'open file handle (external sqlite3 session)': ('fuser.rc', b'0'),
        }
        for name, (file, content) in arrangements.items():
            with self.subTest(name=name):
                self.setUp()
                (self.host.ops.fake / file).write_bytes(content)
                self.assert_unfrozen_and_available(self.freeze(), 80)

    def test_a_write_during_the_quiet_window_refuses_the_freeze(self):
        def late_writer():
            # wait for the freeze to reach the file-handle check, then write inside the quiet window
            deadline = time.time() + 60
            while time.time() < deadline and '"cmd":"fuser"' not in self.host.cutover_log_text():
                time.sleep(0.05)
            time.sleep(0.6)
            self.writer.execute("INSERT INTO booking VALUES (50, 1, 'late')")
            self.writer.commit()
        thread = threading.Thread(target=late_writer)
        thread.start()
        done = self.freeze(seconds='4')
        thread.join()
        self.assert_unfrozen_and_available(done, 80)


class FreezePreconditionTests(FreezeTestCase):
    def test_bad_arguments_and_wrong_phase_do_nothing_to_containers(self):
        self.assertEqual(self.freeze(seconds='0').returncode, 64)
        self.assertEqual(self.freeze(seconds='601').returncode, 64)
        self.state().transition('frozen', '2026-10-23T12:00:00Z')
        self.assertEqual(self.freeze().returncode, 75)
        self.assertEqual(mutations(self.host.cutover_calls()), [])

    def test_stage_is_required_before_freezing(self):
        host = Host(self)
        host.seal()
        self.assertEqual(host.cutover('prepare').returncode, 0)
        self.assertEqual(host.cutover('freeze', '--quiet-seconds', '1').returncode, 75)
        self.assertEqual(mutations(host.cutover_calls()), [])

    def test_docker_failures_stop_the_freeze_with_83_and_keep_the_service_available(self):
        fake = self.host.ops.fake
        (fake / 'stop.rc').write_bytes(b'1')
        done = self.freeze()
        self.assertEqual(done.returncode, 83, done.stderr)
        self.assertEqual(self.state().phase, 'prepared')
        (fake / 'stop.rc').unlink()
        (fake / 'run-d.rc').write_bytes(b'1')
        self.assert_unfrozen_and_available(self.freeze(), 83)


if __name__ == '__main__':
    unittest.main()
