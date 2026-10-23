import hashlib, json, os, pathlib, sqlite3, subprocess, sys, tempfile, unittest

from tests.ops import harness

ROOT = pathlib.Path(__file__).resolve().parents[2]
LEGACY = ROOT / 'scripts/migration/snapshot.py'
OPS_SNAPSHOT = ROOT / 'ops/snapshot.py'


def synthetic_db(path, wal=False):
    db = sqlite3.connect(path, check_same_thread=False)
    if wal:
        db.execute('PRAGMA journal_mode=WAL')
    db.executescript("""
        CREATE TABLE person (id INTEGER PRIMARY KEY, name TEXT NOT NULL, score REAL, photo BLOB, note TEXT);
        CREATE TABLE booking (id INTEGER PRIMARY KEY, person_id INTEGER NOT NULL REFERENCES person(id), slot TEXT);
        CREATE TABLE kv (k TEXT PRIMARY KEY, v) WITHOUT ROWID;
    """)
    db.execute('INSERT INTO person VALUES (1, ?, 1.5, ?, NULL)', ('Ana Example', b'\x00\x01\xff'))
    db.execute('INSERT INTO person VALUES (9223372036854775807, ?, -0.0, NULL, ?)', ('M\u00e1rio \u2603', 'x' * 10))
    db.execute('INSERT INTO booking VALUES (1, 1, ?)', ('2026-01-01T10:00:00Z',))
    db.execute('INSERT INTO kv VALUES (?, ?)', ('a', 1))
    db.execute('INSERT INTO kv VALUES (?, ?)', ('b', b'blob'))
    db.commit()
    return db


def run(script, *args):
    return subprocess.run([sys.executable, '-I', str(script), *map(str, args)], capture_output=True, text=True)


class LogicalChecksumTests(unittest.TestCase):
    def test_logical_checksum_equals_the_importers_own_snapshot_checksum(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = pathlib.Path(tmp) / 'source.db'
            synthetic_db(path).close()
            legacy = json.loads(run(LEGACY, '--read', path).stdout)
            ours = run(OPS_SNAPSHOT, 'logical', path)
            self.assertEqual(ours.returncode, 0, ours.stderr)
            report = json.loads(ours.stdout)
        self.assertEqual(report['checksum'], legacy['checksum'])
        self.assertEqual(report['counts'], {t['name']: len(t['rows']) for t in legacy['tables']})
        # the report is public: counts and the checksum only, never a cell value
        self.assertEqual(sorted(report), ['checksum', 'counts'])
        self.assertNotIn('Ana Example', ours.stdout)


def sha(path):
    return hashlib.sha256(pathlib.Path(path).read_bytes()).hexdigest() if pathlib.Path(path).exists() else None


class BackupTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = pathlib.Path(self._tmp.name)

    def test_backup_captures_uncheckpointed_wal_writes_and_never_touches_the_source(self):
        source = self.tmp / 'source.db'
        db = synthetic_db(source, wal=True)
        db.execute('PRAGMA wal_autocheckpoint=0')
        db.execute('INSERT INTO booking VALUES (2, 1, ?)', ('2026-01-02T10:00:00Z',))
        db.commit()
        before = (sha(source), sha(str(source) + '-wal'))
        self.assertIsNotNone(before[1], 'the committed write must still live only in the WAL')
        done = run(OPS_SNAPSHOT, 'backup', source, self.tmp / 'copy.db')
        after = (sha(source), sha(str(source) + '-wal'))  # before the writer closes and checkpoints the WAL
        db.close()
        self.assertEqual(done.returncode, 0, done.stderr)
        report = json.loads(done.stdout)
        copy = sqlite3.connect(self.tmp / 'copy.db')
        self.assertEqual(copy.execute('SELECT count(*) FROM booking').fetchone()[0], 2)
        copy.close()
        self.assertEqual(report['counts']['booking'], 2)
        self.assertEqual(sorted(report), ['bytes', 'checksum', 'counts', 'file_sha256'])
        self.assertEqual(report['file_sha256'], sha(self.tmp / 'copy.db'))
        self.assertEqual(after, before)
        if os.name == 'posix':
            self.assertEqual(os.stat(self.tmp / 'copy.db').st_mode & 0o777, 0o600)

    def test_backup_refuses_to_overwrite_and_never_leaves_a_broken_copy(self):
        source = self.tmp / 'source.db'
        synthetic_db(source).close()
        (self.tmp / 'taken.db').write_bytes(b'keep me')
        self.assertEqual(run(OPS_SNAPSHOT, 'backup', source, self.tmp / 'taken.db').returncode, 81)
        self.assertEqual((self.tmp / 'taken.db').read_bytes(), b'keep me')
        self.assertEqual(run(OPS_SNAPSHOT, 'backup', source, source).returncode, 81)
        broken = self.tmp / 'broken.db'
        db = sqlite3.connect(broken)
        db.executescript('CREATE TABLE a(id INTEGER PRIMARY KEY); CREATE TABLE b(id INTEGER, a_id INTEGER REFERENCES a(id));'
                         'INSERT INTO b VALUES (1, 99);')
        db.commit()
        db.close()
        done = run(OPS_SNAPSHOT, 'backup', broken, self.tmp / 'broken-copy.db')
        self.assertEqual(done.returncode, 81, done.stderr)
        self.assertEqual(done.stdout, '')
        self.assertFalse((self.tmp / 'broken-copy.db').exists())
        self.assertEqual(sorted(p.name for p in self.tmp.iterdir() if p.name.startswith('.')), [])


if __name__ == '__main__':
    unittest.main()
