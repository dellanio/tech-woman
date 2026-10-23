"""Pre-write freeze of every SQLite writer (operator CLI only). Exit codes: 80 writer present, 83 host command failed.

Order (each confirmation is recorded in freeze.writers_checked): maintenance container in place of the app,
no other tech-woman container, no timer/cron entry, no open file handle on the database files, then a quiet
window in which size/mtime/data_version/content hash of the database stay identical. Any failure puts the
original container back before returning, so a refused freeze never costs availability.
"""
import hashlib, os, pathlib, re, sqlite3, time

import hostops

CONTAINER = 'tech-woman'
ORIGINAL = 'tech-woman-sqlite-original'
MAINTENANCE_SCRIPT = (
    "require('http').createServer((q,r)=>{r.writeHead(503,{'Retry-After':'600','Content-Type':'text/plain'});"
    "r.end('Manutencao programada. Tente novamente em alguns minutos.')}).listen(3000,'0.0.0.0')")
WRITERS = ['app-container', 'mailer-containers', 'timers', 'cron', 'file-handles', 'quiet-window']


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


def freeze(paths, quiet_seconds):
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
        timers = runner.run(['systemctl', 'list-timers', '--all', '--no-pager']).stdout
        if re.search('tech-woman', timers, re.I):
            raise Refusal(80, 'a systemd timer mentions tech-woman')
        cron = runner.run(['crontab', '-l'], ok=(0, 1)).stdout
        if re.search('tech-woman', cron, re.I):
            raise Refusal(80, 'a crontab entry mentions tech-woman')
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
    except hostops.HostError as error:
        _back_out(runner, raised, str(error), error.code)
    except Refusal as refusal:
        _back_out(runner, raised, str(refusal), refusal.code)
    return {'original_container': ORIGINAL, 'original_image': image, 'ip': ip, 'quiet_seconds': quiet_seconds,
            'writers_checked': list(WRITERS)}
