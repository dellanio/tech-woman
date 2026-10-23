import hashlib, json, os, pathlib, sqlite3, subprocess, sys, tempfile, unittest

from tests.ops import harness

ROOT = pathlib.Path(__file__).resolve().parents[2]
LEGACY = ROOT / 'scripts/migration/snapshot.py'
OPS_SNAPSHOT = ROOT / 'ops/snapshot.py'


def synthetic_db(path, wal=False):
    db = sqlite3.connect(path)
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


if __name__ == '__main__':
    unittest.main()
