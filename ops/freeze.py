"""Pre-write freeze of every SQLite writer (operator CLI only). Exit codes: 80 writer present, 83 host command failed.

Order (each confirmation is recorded in freeze.writers_checked): maintenance container in place of the app,
no other tech-woman container, every writer of the operator's closed inventory stopped, no timer/cron/unit entry,
no open file handle on the database files, then a quiet window in which size/mtime/data_version/content hash of the
database stay identical; the files are then write-protected at once. Any failure puts the original container back
before returning (or exits 84 saying it could NOT), so a refused freeze never claims availability it does not have.
"""
import hashlib, os, pathlib, re, sqlite3, time

import hostops

CONTAINER = 'tech-woman'
ORIGINAL = 'tech-woman-sqlite-original'
MAINTENANCE_SCRIPT = (
    "require('http').createServer((q,r)=>{r.writeHead(503,{'Retry-After':'600','Content-Type':'text/plain'});"
    "r.end('Manutencao programada. Tente novamente em alguns minutos.')}).listen(3000,'0.0.0.0')")
WRITERS = ['app-container', 'mailer-containers', 'timers', 'systemd-services', 'cron', 'cron-files', 'file-handles',
           'quiet-window']


class Refusal(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _sample(db_path, connection):
    parts = []
    for suffix in ('', '-wal', '-shm'):
        path = pathlib.Path(str(db_path) + suffix)
        if path.exists():
            info = path.stat()
            parts.append((suffix, info.st_size, info.st_mtime_ns))
    digest = hashlib.sha256(pathlib.Path(db_path).read_bytes()).hexdigest()
    return parts, connection.execute('PRAGMA data_version').fetchone()[0], digest


INVENTORY_KINDS = {'container', 'systemd-unit', 'cron', 'process', 'external'}
ATTESTED_ONLY_KINDS = ('cron', 'process', 'external')
WRITER_ID = re.compile(r'\A[A-Za-z0-9][A-Za-z0-9@._:-]{0,119}\Z')
STILL_RUNNING = {'active', 'activating', 'reloading', 'deactivating'}


def check_inventory(inventory, candidate_sha256):
    """The operator's closed list of every writer of the SQLite file, bound to this candidate.

    Deny by default: anything malformed is 64, another candidate is 70, an open or partial list is 80. Containers
    and systemd units are verified against the host; cron/process/external entries can only be attested by the
    operator and are recorded as such (attested_only), never presented as proven.
    """
    if type(inventory) is not dict or sorted(inventory) != ['candidate_sha256', 'complete', 'decision_ref', 'schema',
                                                             'writers']:
        raise Refusal(64, 'writers inventory has an unexpected shape')
    writers = inventory['writers']
    if not (inventory['schema'] == 1 and type(inventory['schema']) is int and type(inventory['complete']) is bool
            and type(inventory['decision_ref']) is str
            and re.fullmatch(r'[A-Za-z0-9._-]{1,64}', inventory['decision_ref']) is not None
            and type(writers) is list and writers):
        raise Refusal(64, 'writers inventory has invalid values')
    seen = set()
    for writer in writers:
        if type(writer) is not dict or sorted(writer) != ['id', 'kind'] or writer['kind'] not in INVENTORY_KINDS \
                or type(writer['id']) is not str or not WRITER_ID.match(writer['id']) or writer['id'] in seen:
            raise Refusal(64, 'writers inventory has an invalid entry')
        seen.add(writer['id'])
    if inventory['candidate_sha256'] != candidate_sha256:
        raise Refusal(70, 'writers inventory was made for another candidate')
    if not inventory['complete']:
        raise Refusal(80, 'writers inventory is not complete: unknown writers may remain')
    if {'id': CONTAINER, 'kind': 'container'} not in writers:
        raise Refusal(80, 'writers inventory does not list the application container')
    return writers


def source_digest(db_path):
    """sha256 of the database file followed by its WAL: any committed write changes it."""
    db_path = pathlib.Path(db_path)
    wal = pathlib.Path(str(db_path) + '-wal')
    digest = hashlib.sha256(db_path.read_bytes())
    if wal.exists():
        digest.update(wal.read_bytes())
    return digest.hexdigest()


def db_files(db_path):
    return [p for p in (pathlib.Path(db_path), pathlib.Path(str(db_path) + '-wal'), pathlib.Path(str(db_path) + '-shm'))
            if p.exists()]


def write_protect(runner, db_path):
    """chmod a-w on the database files and chattr +i where available. Root can still write: this stops
    accidental writers, it is not a guarantee against root. Returns whether every file became immutable."""
    immutable = True
    for path in db_files(db_path):
        os.chmod(path, os.stat(path).st_mode & ~0o222)
        try:
            runner.run(['chattr', '+i', str(path)])
        except hostops.HostError:
            immutable = False
    return immutable


def _scan_cron(paths):
    """Any cron file (system, drop-ins, every user's spool) naming tech-woman. Reads files, never prints them."""
    for location in paths['TW_CRON_PATHS'].split(','):
        root = pathlib.Path(location)
        try:
            files = [root] if root.is_file() else sorted(p for p in root.rglob('*') if p.is_file())
            if not root.exists():
                raise OSError('missing')
            for path in files:
                if re.search(rb'tech-woman', path.read_bytes()[:1_000_000], re.I):
                    raise Refusal(80, 'a cron file mentions tech-woman: %s' % path.name)
        except OSError:
            raise Refusal(83, 'cannot read the cron location %s, so it cannot be proven free of writers' % root.name)


def _restore(runner, raised):
    """Put the original service back. Returns the commands that FAILED (empty list = restored)."""
    steps = [['docker', 'rm', '-f', CONTAINER], ['docker', 'rename', ORIGINAL, CONTAINER],
             ['docker', 'start', CONTAINER]] if raised else [['docker', 'start', CONTAINER]]
    failed = []
    for argv in steps:
        try:
            runner.run(argv)
        except hostops.HostError:
            failed.append(' '.join(argv[1:]))
    return failed


def _back_out(runner, raised, reason, code):
    failed = _restore(runner, raised)
    if failed:
        raise Refusal(84, 'NOT restored (%s): the original container is kept as %s and the public page may be '
                          'down or in maintenance; operator action required. Original reason: %s'
                      % (', '.join(failed), ORIGINAL, reason))
    raise Refusal(code, reason)


def freeze(paths, quiet_seconds, writers):
    """Returns the freeze record for the state file, or raises Refusal after restoring the original service."""
    runner = hostops.Runner(paths)
    network, db = paths['TW_NETWORK'], pathlib.Path(paths['TW_DB_FILE'])
    try:
        info = runner.run(['docker', 'inspect', CONTAINER, '--format',
                           '{{.Config.Image}}|{{(index .NetworkSettings.Networks "%s").IPAddress}}' % network],
                          error='cannot inspect the running service').stdout.strip()
    except hostops.HostError as error:
        raise Refusal(error.code, str(error))
    image, _, ip = info.partition('|')
    if not (re.fullmatch(r'[A-Za-z0-9./:_@-]+', image) and re.fullmatch(r'\d{1,3}(\.\d{1,3}){3}', ip)):
        raise Refusal(83, 'unexpected container description')
    raised = False
    try:
        runner.run(['docker', 'stop', CONTAINER], error='cannot stop the running service')
        runner.run(['docker', 'rename', CONTAINER, ORIGINAL], error='cannot keep the original container')
        raised = True
        runner.run(['docker', 'run', '-d', '--name', CONTAINER, '--restart', 'unless-stopped', '--network', network,
                    '--ip', ip, '--network-alias', 'app', '--memory', '64m', '--cpus', '0.1',
                    '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '--entrypoint', 'node', image,
                    '-e', MAINTENANCE_SCRIPT], error='cannot start the maintenance container')
        names = runner.run(['docker', 'ps', '--format', '{{.Names}}']).stdout.split()
        if any(name.startswith('tech-woman-') and name != ORIGINAL for name in names):
            raise Refusal(80, 'another tech-woman container is running (mailer or job)')
        for writer in writers:
            if writer['kind'] == 'container' and writer['id'] != CONTAINER and writer['id'] in names:
                raise Refusal(80, 'a listed writer container is still running')
            if writer['kind'] == 'systemd-unit':
                state = runner.run(['systemctl', 'is-active', writer['id']], ok=(0, 1, 2, 3, 4)).stdout.strip()
                if state in STILL_RUNNING:
                    raise Refusal(80, 'a listed systemd unit is still running')
        timers = runner.run(['systemctl', 'list-timers', '--all', '--no-pager']).stdout
        if re.search('tech-woman', timers, re.I):
            raise Refusal(80, 'a systemd timer mentions tech-woman')
        for listing in ('list-unit-files', 'list-units'):
            services = runner.run(['systemctl', listing, '--all', '--no-pager']).stdout
            if re.search('tech-woman', services, re.I):
                raise Refusal(80, 'a systemd unit mentions tech-woman (%s)' % listing)
        cron = runner.run(['crontab', '-l'], ok=(0, 1)).stdout
        if re.search('tech-woman', cron, re.I):
            raise Refusal(80, 'a crontab entry mentions tech-woman')
        _scan_cron(paths)
        holders = runner.run(['fuser', '-v', str(db), str(db) + '-wal', str(db) + '-shm'], ok=(0, 1))
        if holders.returncode == 0:
            raise Refusal(80, 'a process still holds the database files')
        connection = sqlite3.connect(db.resolve().as_uri() + '?mode=ro', uri=True)
        try:
            first = _sample(db, connection)
            time.sleep(quiet_seconds)
            second = _sample(db, connection)
        finally:
            connection.close()
        if first != second:
            raise Refusal(80, 'the database changed during the quiet window')
        digest = source_digest(db)
        immutable = write_protect(runner, db)
    except hostops.HostError as error:
        _back_out(runner, raised, str(error), error.code)
    except Refusal as refusal:
        _back_out(runner, raised, str(refusal), refusal.code)
    return {'original_container': ORIGINAL, 'original_image': image, 'ip': ip, 'quiet_seconds': quiet_seconds,
            'writers_checked': list(WRITERS), 'db_sha256': digest, 'write_protected': True, 'immutable': immutable,
            'attested_only': [w['id'] for w in writers if w['kind'] in ATTESTED_ONLY_KINDS]}
