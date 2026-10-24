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
        live_schema = recover.canonical_schema(pg, paths['TW_PG_DB'], paths['TW_BACKUP_DIR'],
                                               re.sub(r'[^0-9]', '', cutover._now()))
    except (recover.hostops.HostError, ValueError, OSError):
        return check('PF-RESTORE', 'fail', 'the dump did not restore in isolation')
    rows = sum(sum(v.values()) if hasattr(v, 'most_common') else len(v) for v in copy['rows'].values())
    if not copy['rows'] or rows == 0:
        return check('PF-RESTORE', 'fail', 'the restored copy is empty')
    if copy['schema'] != live_schema:
        return check('PF-RESTORE', 'fail', 'restored schema differs from the live schema')
    return check('PF-RESTORE', 'pass', 'restored in isolation: %d tables, %d rows, schema identical' % (len(copy['rows']), rows))


EVIDENCE_FILES = {'PF-PG-PORT': ['ss-ltn.txt'], 'PF-PGADMIN-TLS': ['pgadmin-headers.txt'],
                  'PF-PGADMIN-COOKIE': ['pgadmin-headers.txt'], 'PF-PGADMIN-RATE': ['pgadmin-burst.txt'],
                  'PF-PGADMIN-CONN': ['pgadmin-servers.json'], 'PF-BACKUP-DAILY': ['backup-listing.txt', 'backup-toc.txt'],
                  'PF-NGINX-REDACT': ['nginx-T.txt', 'nginx-readback.txt'],
                  'PF-NO-SHARED-TOUCH': ['shared-before.txt', 'shared-after.txt']}
EVIDENCE_NAME = re.compile(r'\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\Z')
STAMP = re.compile(r'\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\Z')
MAX_AGE_SECONDS = 7 * 24 * 3600
PROBE_TOKEN = 'twprobe' + '0' * 37  # synthetic token the operator requests once to read the nginx log back


def _lines(text):
    return [line.strip() for line in text.splitlines() if line.strip()]


def judge_pg_port(files, paths):
    lines = _lines(files['ss-ltn.txt'])
    if not lines:
        return 'fail', 'empty readback'
    exposed = [l for l in lines if len(l.split()) >= 4 and l.split()[3].endswith(':5432')
               and l.split()[3].rsplit(':', 1)[0] not in ('127.0.0.1', '[::1]', '::1')]
    return ('fail', 'PostgreSQL port bound beyond loopback') if exposed else ('pass', 'no public bind of 5432')


def _headers(text):
    lines = _lines(text)
    status = re.match(r'HTTP/\S+ (\d{3})', lines[0]) if lines else None
    return status, [l.lower() for l in lines[1:]]


def judge_tls(files, paths):
    status, headers = _headers(files['pgadmin-headers.txt'])
    ok = status and status.group(1)[0] in '23' and any(h.startswith('strict-transport-security:') for h in headers)
    return ('pass', 'HTTPS with HSTS') if ok else ('fail', 'no HTTPS answer with HSTS')


def judge_cookie(files, paths):
    _, headers = _headers(files['pgadmin-headers.txt'])
    cookies = [h for h in headers if h.startswith('set-cookie:')]
    if not cookies:
        return 'fail', 'no session cookie observed'
    flags = [{p.strip() for p in c.split(';')[1:]} for c in cookies]
    ok = all('secure' in f and 'httponly' in f for f in flags)
    return ('pass', 'every cookie Secure and HttpOnly') if ok else ('fail', 'a cookie lacks Secure or HttpOnly')


def judge_rate(files, paths):
    codes = _lines(files['pgadmin-burst.txt'])
    if len(codes) < 20 or not all(re.fullmatch(r'\d{3}', c) for c in codes):
        return 'fail', 'burst readback needs at least 20 status codes'
    return ('pass', 'burst answered 429') if '429' in codes else ('fail', 'no 429 under a burst')


def judge_conn(files, paths):
    try:
        servers = json.loads(files['pgadmin-servers.json'])['Servers']
        if type(servers) is not dict:
            raise ValueError
    except (ValueError, KeyError, TypeError):
        return 'fail', 'server export unreadable'
    bad = [s for s in servers.values() if type(s) is not dict or s.get('Username') == 'postgres'
           or any(k in s for k in ('Password', 'SavePassword'))]
    return ('fail', 'a saved connection uses the superuser or keeps a password') if bad else \
        ('pass', '%d saved connections, none superuser' % len(servers))


def judge_backup(files, paths, collected_epoch):
    dumps = []
    for line in _lines(files['backup-listing.txt']):
        parts = line.split()
        if len(parts) != 3 or not re.fullmatch(r'\d+(\.\d+)?', parts[0]) or not parts[1].isdigit():
            return 'fail', 'unexpected listing line'
        dumps.append((float(parts[0]), int(parts[1])))
    if len(dumps) < 7:
        return 'fail', 'fewer than 7 daily dumps retained'
    newest = max(dumps)
    if newest[1] == 0 or collected_epoch - newest[0] > 26 * 3600:
        return 'fail', 'newest dump empty or older than 26h at collection'
    if not re.search(r'^;\s+dbname: %s$' % re.escape(paths['TW_PG_DB']), files['backup-toc.txt'], re.M):
        return 'fail', 'newest dump is not of the Tech Woman database'
    return 'pass', '%d dumps, newest within 26h' % len(dumps)


def judge_nginx(files, paths):
    config, readback = files['nginx-T.txt'], files['nginx-readback.txt']
    if not ('log_format tw_redacted' in config and 'tech-woman-redact-server.conf' in config
            and 'tech-woman.dellanio.com' in config):
        return 'fail', 'redaction not included in the Tech Woman vhost'
    if PROBE_TOKEN in readback or '/api/state/[redacted]' not in readback:
        return 'fail', 'log readback is not redacted'
    return 'pass', 'redacted in the vhost log'


def judge_shared(files, paths):
    before, after = _lines(files['shared-before.txt']), _lines(files['shared-after.txt'])
    if not before or not all(re.match(r'[0-9a-f]{64}  \S', l) for l in before + after):
        return 'fail', 'empty or malformed hash listing'
    return ('pass', 'shared configuration unchanged') if before == after else ('fail', 'shared configuration changed')


JUDGES = {'PF-PG-PORT': judge_pg_port, 'PF-PGADMIN-TLS': judge_tls, 'PF-PGADMIN-COOKIE': judge_cookie,
          'PF-PGADMIN-RATE': judge_rate, 'PF-PGADMIN-CONN': judge_conn, 'PF-NGINX-REDACT': judge_nginx,
          'PF-NO-SHARED-TOUCH': judge_shared}


def _register(paths, candidate_sha256):
    """The operator's evidence register, or None when absent. Raises ValueError when it cannot be trusted."""
    state_dir = pathlib.Path(paths['TW_STATE_DIR'])
    path = state_dir / 'host-evidence.json'
    if not os.path.lexists(path):
        return None
    try:
        cutover._check_private_file(path, cutover._policy(paths))
        register = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, ValueError, cutover.StateError):
        raise ValueError('evidence register unreadable')
    if type(register) is not dict or sorted(register) != ['candidate_sha256', 'items', 'schema'] \
            or register['schema'] != 1 or type(register['items']) is not dict:
        raise ValueError('evidence register has an unexpected shape')
    if register['candidate_sha256'] != candidate_sha256:
        raise ValueError('evidence was collected for another candidate')
    return register


def _evidence(paths, entry, cid, now):
    """(status, detail, files) for one item; files only when every hash matched and the readback is fresh."""
    if type(entry) is not dict or sorted(entry) != ['collected_at', 'files'] or type(entry['files']) is not dict \
            or not STAMP.match(str(entry['collected_at'])):
        return 'fail', 'evidence entry malformed', None
    if sorted(entry['files']) != sorted(EVIDENCE_FILES[cid]):
        return 'fail', 'evidence entry does not name the required readback files', None
    collected = cutover.datetime.datetime.strptime(entry['collected_at'], '%Y-%m-%dT%H:%M:%SZ').replace(
        tzinfo=cutover.datetime.timezone.utc).timestamp()
    if not 0 <= now - collected <= MAX_AGE_SECONDS:
        return 'pending', 'evidence stale or dated in the future: collect again', None
    directory = pathlib.Path(paths['TW_STATE_DIR']) / 'evidence'
    files = {}
    for name, digest in entry['files'].items():
        path = directory / name
        try:
            if not EVIDENCE_NAME.match(name) or not stat.S_ISREG(os.lstat(path).st_mode):
                raise OSError
            data = path.read_bytes()
        except OSError:
            return 'fail', 'evidence file missing or not a plain file', None
        if cutover._sha256(data) != digest:
            return 'fail', 'evidence does not match its recorded hash', None
        files[name] = data.decode('utf-8', 'replace')
    return None, None, (files, collected)


def host_checks(paths, pg, restore_dump, candidate_sha256):
    results = {cid: check(cid, 'pending', 'no operator evidence yet') for cid in HOST_IDS}
    try:
        register = _register(paths, candidate_sha256)
    except ValueError as error:
        register = None
        for cid in EVIDENCE_FILES:
            results[cid] = check(cid, 'fail', str(error))
    now = cutover.datetime.datetime.now(cutover.datetime.timezone.utc).timestamp()
    for cid, entry in ((register or {}).get('items') or {}).items():
        if cid not in EVIDENCE_FILES:
            continue
        status, detail, found = _evidence(paths, entry, cid, now)
        if found is None:
            results[cid] = check(cid, status, detail)
            continue
        files, collected = found
        status, detail = judge_backup(files, paths, collected) if cid == 'PF-BACKUP-DAILY' else JUDGES[cid](files, paths)
        results[cid] = check(cid, status, detail)
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
    checks = sql_checks(pg) + host_checks(paths, pg, restore_dump, candidate_sha256)
    statuses = {c['status'] for c in checks}
    overall = 'fail' if 'fail' in statuses else 'pending' if 'pending' in statuses else 'pass'
    print(json.dumps({'candidate_sha256': candidate_sha256, 'overall': overall, 'checks': checks}, indent=1))
    return {'pass': 0, 'fail': 87, 'pending': 88}[overall]


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
