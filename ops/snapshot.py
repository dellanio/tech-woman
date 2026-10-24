#!/usr/bin/env python3
"""Offline SQLite snapshot tools for the cutover (stdlib only).

The logical checksum is byte-for-byte the one scripts/migration/snapshot.py --read computes and the importer
stores as migration_run.source_checksum; a test compares both on the same file so they cannot drift apart.
Reports are public by construction: counts and checksums, never a cell value.
"""
import base64, contextlib, hashlib, json, os, pathlib, sqlite3, sys


class SnapshotError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _cell(value):
    if value is None:
        return {'type': 'null', 'value': None}
    if isinstance(value, int):
        return {'type': 'integer', 'value': str(value)}
    if isinstance(value, float):
        return {'type': 'real', 'value': value.hex()}
    if isinstance(value, bytes):
        return {'type': 'blob', 'value': base64.b64encode(value).decode('ascii')}
    return {'type': 'text', 'value': value}


def _connect(path):
    return sqlite3.connect(pathlib.Path(path).resolve().as_uri() + '?mode=ro', uri=True)


def _checks(connection):
    if connection.execute('PRAGMA integrity_check').fetchall() != [('ok',)]:
        raise SnapshotError(81, 'SQLite integrity check failed')
    if connection.execute('PRAGMA foreign_key_check').fetchall():
        raise SnapshotError(81, 'SQLite foreign key check failed')


def logical(path):
    """Checksum of the whole database plus public per-table counts (read-only connection)."""
    tables, counts = [], {}
    with contextlib.closing(_connect(path)) as db:
        db.execute('BEGIN')
        _checks(db)
        for name, ddl in db.execute("SELECT name,sql FROM sqlite_master WHERE type='table' ORDER BY name").fetchall():
            quoted = '"' + name.replace('"', '""') + '"'
            columns = [[_cell(v) for v in row] for row in db.execute('PRAGMA table_xinfo(%s)' % quoted)]
            rows = [[_cell(v) for v in row] for row in db.execute('SELECT * FROM %s' % quoted)]
            tables.append({'name': name, 'ddl': ddl, 'columns': columns, 'rows': rows})
            counts[name] = len(rows)
        db.rollback()
    content = {'format': 1, 'integrity': 'ok', 'tables': tables}
    checksum = hashlib.sha256(json.dumps(content, ensure_ascii=True, separators=(',', ':'),
                                         sort_keys=True).encode()).hexdigest()
    return {'checksum': checksum, 'counts': counts}


def backup(source, target):
    """Online Backup API copy of a (possibly WAL-mode) database, read-only on the source, mode 0600, checked."""
    source, target = pathlib.Path(source).resolve(), pathlib.Path(target)
    if target.exists() or target.resolve() == source:
        raise SnapshotError(81, 'refusing to overwrite an existing file or the source')
    partial = target.with_name('.' + target.name + '.partial')
    descriptor = os.open(partial, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        reader, writer = _connect(source), sqlite3.connect(partial)
        try:
            reader.backup(writer, pages=256)
            writer.execute('PRAGMA journal_mode=DELETE')
            _checks(writer)
        finally:
            writer.close()
            reader.close()
        os.replace(partial, target)
    except BaseException:
        for leftover in (partial, partial.with_name(partial.name + '-wal'), partial.with_name(partial.name + '-shm')):
            if leftover.exists():
                leftover.unlink()
        raise
    report = logical(target)
    report.update(file_sha256=hashlib.sha256(target.read_bytes()).hexdigest(), bytes=target.stat().st_size)
    return report


def main(argv):
    try:
        if len(argv) == 3 and argv[1] == 'logical':
            print(json.dumps(logical(argv[2])))
            return 0
        if len(argv) == 4 and argv[1] == 'backup':
            print(json.dumps(backup(argv[2], argv[3])))
            return 0
    except sqlite3.Error as error:
        print('snapshot: SQLite refused the operation (%s)' % type(error).__name__, file=sys.stderr)
        return 81
    except SnapshotError as error:
        print('snapshot: %s' % error, file=sys.stderr)
        return error.code
    print('usage: snapshot.py {logical <db>|backup <source> <target>}', file=sys.stderr)
    return 64


if __name__ == '__main__':
    sys.exit(main(sys.argv))
