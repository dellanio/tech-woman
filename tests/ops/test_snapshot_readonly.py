"""OPS-001 #2: ops/snapshot.py reads a WAL-mode SQLite file in a READ-ONLY directory (no -shm can be created), and
refuses (81) when a non-empty -wal is pending there, so committed frames are never silently ignored by immutable=1.
The read runs as a non-root uid (root ignores directory permissions), through the real CLI."""
import os, pathlib, shutil, sqlite3, subprocess, sys, tempfile, unittest

SNAPSHOT = pathlib.Path(__file__).resolve().parents[2] / 'ops' / 'snapshot.py'


def as_unprivileged(argv):
    if os.geteuid() == 0:
        return ['setpriv', '--reuid=1000', '--regid=1000', '--clear-groups'] + argv
    return argv


@unittest.skipUnless(os.name == 'posix', 'directory permissions need POSIX (run in the Linux container)')
class ReadOnlyDirectoryTests(unittest.TestCase):
    def setUp(self):
        self.root = pathlib.Path(tempfile.mkdtemp(prefix='tw-ro-'))
        os.chmod(self.root, 0o755)
        self.dir = self.root / 'dados'
        self.dir.mkdir()
        self.db = self.dir / 'tech-woman.db'
        self.addCleanup(shutil.rmtree, self.root, True)
        self.addCleanup(os.chmod, self.dir, 0o755)
        with sqlite3.connect(self.db) as db:
            self.assertEqual(db.execute('pragma journal_mode=wal').fetchone()[0], 'wal')
            db.execute('create table participant (id integer primary key, name text)')
            db.executemany('insert into participant (name) values (?)', [('a',), ('b',), ('c',)])
        db.close()

    def read(self):
        return subprocess.run(as_unprivileged([sys.executable, str(SNAPSHOT), 'logical', str(self.db)]),
                              capture_output=True, text=True)

    def lock_down(self):
        for path in self.dir.iterdir():
            os.chmod(path, 0o644)
        os.chmod(self.dir, 0o555)

    def test_a_wal_database_in_a_read_only_directory_is_read_without_touching_it(self):
        self.assertFalse(pathlib.Path(str(self.db) + '-shm').exists())  # closed cleanly: WAL checkpointed, no -shm
        before = sorted((p.name, p.stat().st_size, p.stat().st_mtime_ns) for p in self.dir.iterdir())
        self.lock_down()
        done = self.read()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('"participant": 3', done.stdout)
        self.assertEqual(sorted((p.name, p.stat().st_size, p.stat().st_mtime_ns) for p in self.dir.iterdir()), before)

    def test_a_pending_wal_in_a_read_only_directory_is_refused_not_ignored(self):
        writer = sqlite3.connect(self.db)
        self.addCleanup(writer.close)
        writer.execute('pragma wal_autocheckpoint=0')
        writer.execute("insert into participant (name) values ('committed-in-wal')")
        writer.commit()
        copy = self.root / 'copia'  # the db and its pending -wal, without -shm (e.g. a read-only mount of the files)
        copy.mkdir()
        for suffix in ('', '-wal'):
            shutil.copyfile(str(self.db) + suffix, str(copy / self.db.name) + suffix)
        self.assertGreater(pathlib.Path(str(copy / self.db.name) + '-wal').stat().st_size, 0)
        self.dir, self.db = copy, copy / self.db.name
        self.addCleanup(os.chmod, copy, 0o755)
        self.lock_down()
        done = self.read()
        self.assertEqual(done.returncode, 81, done.stdout + done.stderr)
        self.assertIn('pending WAL', done.stderr)
        self.assertNotIn('"participant": 3', done.stdout)  # never a silently stale read that ignores the WAL

    def test_a_read_only_directory_with_the_shm_present_reads_the_wal_too(self):
        writer = sqlite3.connect(self.db)
        self.addCleanup(writer.close)
        writer.execute('pragma wal_autocheckpoint=0')
        writer.execute("insert into participant (name) values ('committed-in-wal')")
        writer.commit()
        self.lock_down()
        done = self.read()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('"participant": 4', done.stdout)

    def test_a_writable_directory_keeps_the_plain_read_only_mode(self):
        done = self.read() if os.geteuid() != 0 else subprocess.run(
            [sys.executable, str(SNAPSHOT), 'logical', str(self.db)], capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('"participant": 3', done.stdout)


if __name__ == '__main__':
    unittest.main()
