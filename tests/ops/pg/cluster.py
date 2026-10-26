"""Disposable PostgreSQL 16 cluster owned by the ops tests (never a shared or production cluster).

Required environment (a missing prerequisite FAILS the test, it is never skipped):
  WP005_PG_DATA  data directory of the disposable cluster (created by initdb when empty)
  WP005_PG_PORT  TCP port on 127.0.0.1 (trust auth, no password, no unix socket)
Optional: PG_BIN (directory with initdb/pg_ctl), PG_SHARE (initdb -L), PG_CLIENT_BIN (psql/pg_dump/pg_restore).
When the tests run as root the server runs as uid/gid 1000 (setpriv): PostgreSQL refuses to run as root.

CLI (used by the TypeScript tests): python3 tests/ops/pg/cluster.py ensure  -> prints the admin URL.
"""
import os, pathlib, shutil, subprocess, sys, uuid


class Missing(AssertionError):
    pass


def _env(name):
    value = os.environ.get(name)
    if not value:
        raise Missing('%s is required: the ops PostgreSQL tests need their own disposable PostgreSQL 16 cluster '
                      '(see tests/ops/pg/cluster.py and docs/operations-postgres.md)' % name)
    return value


def _tool(name, var='PG_BIN'):
    directory = os.environ.get(var)
    path = os.path.join(directory, name) if directory else shutil.which(name)
    if not path or not os.path.exists(path):
        raise Missing('PostgreSQL 16 tool %s not found (set %s or PATH): it is a prerequisite, not optional' % (name, var))
    return path


def client(name):
    return _tool(name, 'PG_CLIENT_BIN')


class Cluster:
    def __init__(self):
        self.data = pathlib.Path(_env('WP005_PG_DATA')).resolve()
        self.port = int(_env('WP005_PG_PORT'))
        self.host = '127.0.0.1'

    def _as_server(self, argv):
        if hasattr(os, 'geteuid') and os.geteuid() == 0:
            return ['setpriv', '--reuid=1000', '--regid=1000', '--clear-groups'] + argv
        return argv

    def _run(self, argv, check=True):
        done = subprocess.run(self._as_server(argv), capture_output=True, text=True)
        if check and done.returncode != 0:
            raise AssertionError('%s failed (%d): %s' % (os.path.basename(argv[0]), done.returncode, done.stderr[-800:]))
        return done

    def options(self):
        return "-p %d -c listen_addresses=127.0.0.1 -c unix_socket_directories=''" % self.port

    def ensure(self):
        if not (self.data / 'PG_VERSION').exists():
            self.data.mkdir(parents=True, exist_ok=True)
            if hasattr(os, 'geteuid') and os.geteuid() == 0:
                os.chown(self.data, 1000, 1000)
            os.chmod(self.data, 0o700)
            argv = [_tool('initdb'), '-D', str(self.data), '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--locale=C']
            if os.environ.get('PG_SHARE'):
                argv += ['-L', os.environ['PG_SHARE']]
            self._run(argv)
        if self._run([_tool('pg_ctl'), '-D', str(self.data), 'status'], check=False).returncode != 0:
            self._run([_tool('pg_ctl'), '-D', str(self.data), '-o', self.options(), '-l', str(self.data / 'server.log'),
                       '-w', '-t', '60', 'start'])
        version = self.psql('postgres', 'select version()').strip()
        if not version.startswith('PostgreSQL 16.'):
            raise Missing('the disposable cluster must be PostgreSQL 16, found: ' + version)
        return version

    def restart_immediate(self):
        """Crash-like restart: every backend dies without a checkpoint; WAL replay must keep committed data."""
        self._run([_tool('pg_ctl'), '-D', str(self.data), '-m', 'immediate', '-w', '-t', '60', 'stop'])
        self._run([_tool('pg_ctl'), '-D', str(self.data), '-o', self.options(), '-l', str(self.data / 'server.log'),
                   '-w', '-t', '60', 'start'])

    def env(self):
        return dict(os.environ, PGHOST=self.host, PGPORT=str(self.port), PGUSER='postgres')

    def url(self, db='postgres'):
        return 'postgresql://postgres@%s:%d/%s' % (self.host, self.port, db)

    def psql(self, db, sql, role=None):
        argv = [client('psql'), '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', '-d', db, '-f', '-']
        env = self.env()
        if role:
            env['PGOPTIONS'] = '-c role=%s' % role
        done = subprocess.run(argv, input=sql, capture_output=True, text=True, env=env)
        if done.returncode != 0:
            raise AssertionError('psql failed: ' + done.stderr[-800:])
        return done.stdout

    def create_database(self, prefix):
        name = '%s_%s' % (prefix, uuid.uuid4().hex[:12])
        self.psql('postgres', 'create database %s' % name)
        return name

    def drop_database(self, name):
        self.psql('postgres', 'drop database if exists %s with (force)' % name)


if __name__ == '__main__':
    if sys.argv[1:] != ['ensure']:
        print('usage: cluster.py ensure', file=sys.stderr)
        sys.exit(64)
    cluster = Cluster()
    cluster.ensure()
    print(cluster.url())
