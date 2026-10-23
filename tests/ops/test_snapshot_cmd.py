import hashlib, json, os, pathlib, sqlite3, subprocess, sys, threading, time, unittest

from tests.ops import harness
from tests.ops.hostfixture import Host
from tests.ops.test_snapshot import LEGACY

cutover = harness.load_ops_module('cutover')


def legacy_checksum(path):
    done = subprocess.run([sys.executable, '-I', str(LEGACY), '--read', str(path)], capture_output=True, text=True)
    return json.loads(done.stdout)['checksum']


class SnapshotCommandTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.db, self.writer = self.host.sqlite()
        self.addCleanup(self.writer.close)

    def state(self):
        return cutover.State.load(self.host.state_dir, cutover.UNCHECKED)

    def private(self):
        return self.host.state_dir / 'private'


class SnapshotHappyPathTests(SnapshotCommandTestCase):
    def test_final_snapshot_after_freeze_is_double_checked_private_and_leaves_the_source_read_only(self):
        before_rehearsal = legacy_checksum(self.db)
        self.writer.execute("INSERT INTO booking VALUES (7, 1, 'written after the rehearsal')")
        self.writer.commit()
        self.host.frozen()
        source_hash = hashlib.sha256(self.db.read_bytes()).hexdigest()
        done = self.host.cutover('snapshot')
        self.assertEqual(done.returncode, 0, done.stderr)
        state = self.state()
        self.assertEqual((state.phase, state.seq), ('snapshotted', 4))
        snapshot = state.data['snapshot']
        self.assertEqual(snapshot['sha256'], legacy_checksum(self.db))
        self.assertNotEqual(snapshot['sha256'], before_rehearsal)  # the write between rehearsal and cutover is in
        self.assertEqual(snapshot['counts_public']['booking'], 2)
        self.assertRegex(snapshot['a_digest'], '^[0-9a-f]{64}$')
        self.assertRegex(snapshot['b_digest'], '^[0-9a-f]{64}$')
        for name in (snapshot['file_a'], snapshot['file_b']):
            copy = self.private() / name
            self.assertEqual(legacy_checksum(copy), snapshot['sha256'])
            if os.name == 'posix':
                self.assertEqual(os.stat(copy).st_mode & 0o777, 0o600)
        self.assertTrue((self.private() / 'manifest.json').exists())
        self.assertEqual(hashlib.sha256(self.db.read_bytes()).hexdigest(), source_hash)
        self.assertFalse((os.stat(self.db).st_mode & 0o200 != 0))
        self.assertIn('chattr', [c['cmd'] for c in self.host.cutover_calls()])
        public = done.stdout + done.stderr
        self.assertNotIn('Ana Example', public)
        self.assertNotIn('written after', public)
        self.assertNotIn(snapshot['sha256'], public)


class SnapshotRefusalTests(SnapshotCommandTestCase):
    def test_a_write_between_snapshot_a_and_b_is_refused_and_leaves_everything_writable(self):
        self.host.frozen(quiet_seconds=4)

        def remaining_writer():
            deadline = time.time() + 60
            while time.time() < deadline and not list(self.private().glob('*-A.db')):
                time.sleep(0.05)
            time.sleep(0.5)
            self.writer.execute("INSERT INTO booking VALUES (60, 1, 'between A and B')")
            self.writer.commit()
        thread = threading.Thread(target=remaining_writer)
        thread.start()
        done = self.host.cutover('snapshot')
        thread.join()
        self.assertEqual(done.returncode, 81, done.stderr)
        self.assertEqual(self.state().phase, 'frozen')
        self.assertTrue((os.stat(self.db).st_mode & 0o200 != 0))
        self.assertNotIn('chattr', [c['cmd'] for c in self.host.cutover_calls()])

    def test_corrupt_source_and_wrong_phase_are_refused_without_state_change(self):
        self.host.staged()  # still prepared: not frozen
        self.assertEqual(self.host.cutover('snapshot').returncode, 75)
        self.state().transition('frozen', '2026-10-23T12:00:00Z', freeze={'quiet_seconds': 1, 'at': 'x', 'cutoff_at': 'x'})
        self.writer.execute('PRAGMA foreign_keys=OFF')
        self.writer.execute('INSERT INTO booking VALUES (70, 4040, ?)', ('orphan',))
        self.writer.commit()
        done = self.host.cutover('snapshot')
        self.assertEqual(done.returncode, 81, done.stderr)
        self.assertEqual(self.state().phase, 'frozen')
        self.assertTrue((os.stat(self.db).st_mode & 0o200 != 0))


if __name__ == '__main__':
    unittest.main()
