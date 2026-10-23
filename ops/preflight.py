#!/usr/bin/env python3
"""Preflight T12/T18 for the operator (OPS-002). Stdlib only. Usage: preflight.py run [--restore-dump NAME]

Exit 0 = every check passed; 87 = at least one check failed; 88 = nothing failed but something is still pending.
SQL checks (T12) run read-only inside the PostgreSQL container (ops/sql/preflight.sql) plus the WP-003 grants matrix
(ops/sql/agenda-grants-matrix.sql, a byte copy, run in a transaction it rolls back itself). Host items (T18) are
PENDING until the operator supplies readback evidence; they never pass on a self-declared value. Nothing here creates
or revokes a permission; PF-RESTORE creates one NEW isolated database and leaves it for the operator to inspect/drop.
No free command, SQL or path is accepted: the only input is the plain name of a dump in TW_BACKUP_DIR.
"""
import json, os, pathlib, re, stat, sys

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import cutover, recover  # noqa: E402

SQL_IDS = ['PF-ROLE-FLAGS', 'PF-ROLE-MEMBER', 'PF-PUBLIC-SCHEMA', 'PF-PUBLIC-FUNC', 'PF-DEFPRIV', 'PF-COLGRANT',
           'PF-ROLE-LIMITS', 'PF-OTHER-DB', 'PF-HBA']
HOST_IDS = ['PF-PG-PORT', 'PF-PGADMIN-TLS', 'PF-PGADMIN-COOKIE', 'PF-PGADMIN-RATE', 'PF-PGADMIN-CONN',
            'PF-BACKUP-DAILY', 'PF-RESTORE', 'PF-NGINX-REDACT', 'PF-NO-SHARED-TOUCH']
MATRIX_EXPECTED = (581, 18, 46)
MATRIX_OK = re.compile(r'MATRIX OK: (\d+) negações por privilégio executadas, (\d+) execuções permitidas, (\d+) verificações')
DUMP_NAME = re.compile(r'\A[A-Za-z0-9][A-Za-z0-9._-]{0,122}\.dump\Z')


class Usage(Exception):
    pass


def check(cid, status, detail):
    return {'id': cid, 'status': status, 'detail': detail}


def sql_checks(pg):
    """Every SQL check is FAIL when the database cannot be read: an unreadable database proves nothing."""
    try:
        counts = recover._json(pg.read_only((HERE / 'sql/preflight.sql').read_text(encoding='utf-8')))
        if type(counts) is not dict:
            raise ValueError('unexpected answer')
    except (recover.hostops.HostError, ValueError) as error:
        return [check(cid, 'fail', 'database not readable') for cid in SQL_IDS]
    results = {}
    for cid in SQL_IDS:
        if cid == 'PF-COLGRANT':
            continue
        bad = (counts.get(cid) or {}).get('bad')
        results[cid] = check(cid, 'pass', '0 offending objects') if bad == 0 else \
            check(cid, 'fail', '%s offending objects' % bad if type(bad) is int else 'no answer')
    results['PF-COLGRANT'] = matrix(pg)
    return [results[cid] for cid in SQL_IDS]


def matrix(pg):
    done = pg.runner.run(pg.prefix + ['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-U', pg.user, '-d', pg.db, '-f', '-'],
                         stdin=(HERE / 'sql/agenda-grants-matrix.sql').read_text(encoding='utf-8'), ok=range(0, 256))
    found = MATRIX_OK.search(done.stderr) if done.returncode == 0 else None
    if not found:
        failed = re.search(r'MATRIX FAIL: ([^\n(]{1,120})', done.stderr)
        return check('PF-COLGRANT', 'fail', 'matrix failed: %s' % (failed.group(1).strip() if failed else 'no result'))
    counts = tuple(int(x) for x in found.groups())
    detail = '%d denied, %d allowed, %d checked' % counts
    return check('PF-COLGRANT', 'pass' if counts == MATRIX_EXPECTED else 'fail', detail if counts == MATRIX_EXPECTED
                 else detail + ' (expected %d/%d/%d)' % MATRIX_EXPECTED)


def restore_check(paths, pg, name):
    """PF-RESTORE: the daily dump really restores, in a NEW isolated database, with the live schema."""
    path = pathlib.Path(paths['TW_BACKUP_DIR']) / name
    restored = '%s_preflight_%s' % (paths['TW_PG_DB'], re.sub(r'[^0-9]', '', cutover._now()))
    try:
        pg.create_database(restored)
        pg.restore(path, restored)
        copy = recover.fingerprint(pg, restored)
        live_schema = pg.schema(paths['TW_PG_DB'])
    except (recover.hostops.HostError, ValueError):
        return check('PF-RESTORE', 'fail', 'the dump did not restore in isolation')
    rows = sum(sum(v.values()) if hasattr(v, 'most_common') else len(v) for v in copy['rows'].values())
    if not copy['rows'] or rows == 0:
        return check('PF-RESTORE', 'fail', 'the restored copy is empty')
    if copy['schema'] != live_schema:
        return check('PF-RESTORE', 'fail', 'restored schema differs from the live schema')
    return check('PF-RESTORE', 'pass', 'restored in isolation: %d tables, %d rows, schema identical' % (len(copy['rows']), rows))


def host_checks(paths, pg, restore_dump):
    results = {cid: check(cid, 'pending', 'no operator evidence yet') for cid in HOST_IDS}
    if restore_dump is not None:
        results['PF-RESTORE'] = restore_check(paths, pg, restore_dump)
    return [results[cid] for cid in HOST_IDS]


def parse_args(argv):
    if not argv or argv[0] != 'run':
        raise Usage('usage: preflight.py run [--restore-dump NAME]')
    rest = argv[1:]
    if rest == []:
        return None
    if len(rest) != 2 or rest[0] != '--restore-dump':
        raise Usage('usage: preflight.py run [--restore-dump NAME]')
    return rest[1]


def main(argv):
    try:
        restore_dump = parse_args(argv)
        paths = cutover.read_paths()
        if restore_dump is not None:
            if not DUMP_NAME.match(restore_dump):
                raise Usage('--restore-dump must be the plain name of a .dump file in the backup directory')
            try:
                if not stat.S_ISREG(os.lstat(pathlib.Path(paths['TW_BACKUP_DIR']) / restore_dump).st_mode):
                    raise Usage('--restore-dump is not a plain file')
            except OSError:
                raise Usage('no such dump in the backup directory')
        cutover._sealed_candidate(paths, cutover._manifest())
        candidate_sha256 = cutover._sha256((pathlib.Path(paths['TW_STATE_DIR']) / 'candidate.json').read_bytes())
    except Usage as error:
        print('preflight: %s' % error, file=sys.stderr)
        return 64
    except cutover.StateError as error:
        print('preflight: %s' % error, file=sys.stderr)
        return error.code
    pg = recover.Pg(paths)
    checks = sql_checks(pg) + host_checks(paths, pg, restore_dump)
    statuses = {c['status'] for c in checks}
    overall = 'fail' if 'fail' in statuses else 'pending' if 'pending' in statuses else 'pass'
    print(json.dumps({'candidate_sha256': candidate_sha256, 'overall': overall, 'checks': checks}, indent=1))
    return {'pass': 0, 'fail': 87, 'pending': 88}[overall]


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
