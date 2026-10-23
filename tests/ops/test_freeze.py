import hashlib, os, threading, time, unittest

from tests.ops import harness
from tests.ops.hostfixture import INVENTORY_WRITERS, ORIGINAL_IMAGE, ORIGINAL_IP, Host, source_digest

cutover = harness.load_ops_module('cutover')
MUTATING = ('stop', 'rename', 'rm', 'start', 'run')


def docker(calls):
    return [c['args'] for c in calls if c['cmd'] == 'docker']


def mutations(calls):
    return [a for a in docker(calls) if a[0] in MUTATING]


# Restoration order: the maintenance page is only parked (never removed) until the original answers its smoke.
RESTORE_OK = [['stop', 'tech-woman'], ['rename', 'tech-woman', 'tech-woman-maintenance'],
              ['rename', 'tech-woman-sqlite-original', 'tech-woman'], ['start', 'tech-woman'], ['exec', 'tech-woman'],
              ['rm', '-f', 'tech-woman-maintenance']]
MAINTENANCE_BACK = [['stop', 'tech-woman'], ['rename', 'tech-woman', 'tech-woman-sqlite-original'],
                    ['rename', 'tech-woman-maintenance', 'tech-woman'], ['start', 'tech-woman']]


def restore_tail(calls):
    """Docker calls from the parking of the maintenance container on, with exec reduced to its target."""
    args = [c['args'] for c in calls if c['cmd'] == 'docker' and c['args'][0] in MUTATING + ('exec',)]
    start = max(i for i, a in enumerate(args) if a == ['stop', 'tech-woman'])
    return [a[:2] if a[0] == 'exec' else a for a in args[start:]]


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
        if calls:  # the original comes back and is proven healthy BEFORE the maintenance container goes
            tail = [a[:2] if a[0] == 'exec' else a for c in self.host.cutover_calls() if c['cmd'] == 'docker'
                    for a in [c['args']] if a[0] in MUTATING + ('exec',)]
            if (self.host.ops.fake / 'run-d.rc').exists():  # maintenance never came up: nothing to park
                self.assertEqual(tail[-3:], [['rename', 'tech-woman-sqlite-original', 'tech-woman'],
                                             ['start', 'tech-woman'], ['exec', 'tech-woman']])
            else:
                self.assertEqual(restore_tail(self.host.cutover_calls()), RESTORE_OK)


class FreezeHappyPathTests(FreezeTestCase):
    def test_freeze_raises_maintenance_in_place_confirms_every_writer_and_records_the_phase(self):
        done = self.freeze()
        self.assertEqual(done.returncode, 0, done.stderr)
        state = self.state()
        self.assertEqual((state.phase, state.seq), ('frozen', 3))
        freeze = state.data['freeze']
        self.assertEqual(freeze['writers_checked'], ['app-container', 'mailer-containers', 'timers', 'systemd-services',
                                                     'cron', 'cron-files', 'file-handles', 'quiet-window'])
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


class FreezeBroaderWritersTests(FreezeTestCase):
    def test_cron_files_of_any_user_and_systemd_services_without_a_timer_also_refuse(self):
        cron = self.host.ops.host / 'cron'

        def spool():
            (cron / 'spool').mkdir()
            (cron / 'spool' / 'deploy').write_bytes(b'5 4 * * * /opt/tech-woman/run' + bytes([10]))

        def drop_in():
            (cron / 'cron.d').mkdir()
            (cron / 'cron.d' / 'job').write_bytes(b'@daily root tech-woman-export' + bytes([10]))

        fake = self.host.ops.fake
        cases = {
            'system crontab file': lambda: (cron / 'crontab').write_bytes(b'0 * * * * root /usr/local/bin/Tech-Woman-sync' + bytes([10])),
            'cron.d drop-in': drop_in,
            'another users spool crontab': spool,
            'service unit without a timer': lambda: (fake / 'unit-files').write_bytes(b'tech-woman-worker.service enabled' + bytes([10])),
            'running service': lambda: (fake / 'units').write_bytes(b'tech-woman-sync.service loaded active running' + bytes([10])),
        }
        for name, arrange in cases.items():
            with self.subTest(name=name):
                self.setUp()
                cron = self.host.ops.host / 'cron'
                fake = self.host.ops.fake
                arrange()
                done = self.freeze()
                self.assert_unfrozen_and_available(done, 80)
                self.assertNotIn('0 * * * *', done.stderr)  # the message names the source, never the file content

    def test_a_cron_location_that_cannot_be_read_proves_nothing_and_refuses_with_83(self):
        (self.host.ops.host / 'cron').rmdir()
        self.assert_unfrozen_and_available(self.freeze(), 83)


class FreezeInventoryTests(FreezeTestCase):
    """Achado 1: a keyword scan cannot prove every writer is gone; the operator's closed inventory is required."""

    def sealed(self):
        return self.state().candidate_sha256

    def test_without_a_valid_closed_inventory_for_this_candidate_nothing_is_touched(self):
        writers = [dict(w) for w in INVENTORY_WRITERS]
        cases = {
            'missing inventory': (None, 80),
            'incomplete (unknown writers remain)': ({'complete': False}, 80),
            'inventory of another candidate': ({'candidate_sha256': 'f' * 64}, 70),
            'app container not listed': ({'writers': [w for w in writers if w['id'] != 'tech-woman']}, 80),
            'unknown kind': ({'writers': writers + [{'id': 'x', 'kind': 'guess'}]}, 64),
            'shell in a unit id': ({'writers': writers + [{'id': 'a;rm -rf /', 'kind': 'systemd-unit'}]}, 64),
            'command substitution in an id': ({'writers': writers + [{'id': '$(id)', 'kind': 'container'}]}, 64),
            'duplicate id': ({'writers': writers + [dict(writers[0])]}, 64),
            'extra field': ({'note': 'trust me'}, 64),
        }
        for name, (changes, code) in cases.items():
            with self.subTest(name=name):
                self.setUp()
                path = self.host.state_dir / 'writers-inventory.json'
                if changes is None:
                    path.unlink()
                else:
                    self.host.write_inventory(self.sealed(), **changes)
                done = self.freeze()
                self.assertEqual(done.returncode, code, done.stderr)
                self.assertEqual((self.state().phase, self.state().seq), ('prepared', 2))
                self.assertEqual(mutations(self.host.cutover_calls()), [])
                self.assertNotIn('rm -rf', done.stderr)
                self.assertNotIn('$(id)', done.stderr)

    def test_a_listed_writer_that_is_still_running_refuses_and_restores(self):
        cases = {
            'listed unit still active': ('active/tech-woman-backup.service', b'active\n'),
            'listed container still running': ('ps', b'tech-woman\ntech-woman-mailer\n'),
        }
        for name, (file, content) in cases.items():
            with self.subTest(name=name):
                self.setUp()
                target = self.host.ops.fake / file
                target.parent.mkdir(exist_ok=True)
                target.write_bytes(content)
                self.assert_unfrozen_and_available(self.freeze(), 80)

    def test_freeze_binds_the_inventory_and_write_protects_the_source_at_once(self):
        done = self.freeze()
        self.assertEqual(done.returncode, 0, done.stderr)
        freeze = self.state().data['freeze']
        inventory = (self.host.state_dir / 'writers-inventory.json').read_bytes()
        self.assertEqual(freeze['inventory_sha256'], hashlib.sha256(inventory).hexdigest())
        self.assertEqual(freeze['attested_only'], ['root-crontab-sync', 'pgadmin-operator-session'])
        self.assertEqual(freeze['db_sha256'], source_digest(self.db))
        self.assertTrue(freeze['write_protected'])
        self.assertEqual(os.stat(self.db).st_mode & 0o222, 0)
        chattr = [c['args'] for c in self.host.cutover_calls() if c['cmd'] == 'chattr']
        self.assertIn('+i', [a[0] for a in chattr])
        active = [c['args'] for c in self.host.cutover_calls() if c['cmd'] == 'systemctl' and c['args'][0] == 'is-active']
        self.assertEqual(active, [['is-active', 'tech-woman-backup.service']])
        self.assertNotIn('pgadmin-operator-session', done.stdout + done.stderr)


class FreezeRestoreSafetyTests(FreezeTestCase):
    """Review: a failed restoration must keep the maintenance page (503), never leave the address silently empty."""

    def refuse_and_restore(self, **fake):
        (self.host.ops.fake / 'fuser.rc').write_bytes(b'0')  # a writer is found: the freeze backs out
        for name, content in fake.items():
            (self.host.ops.fake / name).write_bytes(content)
        return self.freeze()

    def test_the_original_must_answer_its_smoke_before_the_maintenance_container_is_removed(self):
        done = self.refuse_and_restore()
        self.assertEqual(done.returncode, 80, done.stderr)
        self.assertEqual(restore_tail(self.host.cutover_calls()), RESTORE_OK)
        self.assertNotIn(['rm', '-f', 'tech-woman'], docker(self.host.cutover_calls()))

    def test_an_original_that_does_not_come_back_healthy_puts_the_maintenance_page_back_with_84(self):
        cases = {
            'original fails its smoke': {'exec-tech-woman.rc.1': b'1', 'exec-tech-woman.rc.2': b'1'},
            'original does not start': {'start.tech-woman.rc': b'1'},
            'original cannot take the name': {'rename.tech-woman-sqlite-original.rc': b'1'},
        }
        for name, fake in cases.items():
            with self.subTest(name=name):
                self.setUp()
                done = self.refuse_and_restore(**{k: v for k, v in fake.items()})
                self.assertEqual(done.returncode, 84, done.stderr)
                self.assertIn('NOT restored', done.stderr)
                self.assertIn('maintenance page kept', done.stderr)
                calls = docker(self.host.cutover_calls())
                self.assertNotIn(['rm', '-f', 'tech-woman-maintenance'], calls)
                self.assertNotIn(['rm', '-f', 'tech-woman'], calls)
                tail = [a for a in calls if a[0] in MUTATING][-2:]
                self.assertEqual(tail, [['rename', 'tech-woman-maintenance', 'tech-woman'], ['start', 'tech-woman']])
                self.assertEqual((self.state().phase, self.state().seq), ('prepared', 2))


class FreezeRestoreFailureTests(FreezeTestCase):
    def test_a_restore_that_fails_is_reported_loudly_and_never_claimed_as_available(self):
        fake = self.host.ops.fake
        (fake / 'fuser.rc').write_bytes(b'0')     # a writer is found, so the freeze must back out ...
        (fake / 'rename.rc.2').write_bytes(b'1')  # ... but putting the original back (2nd rename) fails
        done = self.freeze()
        self.assertEqual(done.returncode, 84, done.stderr)
        self.assertIn('NOT restored', done.stderr)
        self.assertIn('tech-woman-sqlite-original', done.stderr)
        self.assertEqual(self.state().phase, 'prepared')
        self.assertEqual(self.state().seq, 2)
        # a later successful restore path is unaffected: the original is still where freeze put it
        self.assertTrue(any(a[:2] == ['rename', 'tech-woman-sqlite-original']
                            for a in docker(self.host.cutover_calls())))


if __name__ == '__main__':
    unittest.main()
