"""Synthetic host for gate/stage/cutover tests: staged ops package, sealed candidate, scratch state dir."""
import datetime, json, os, pathlib, subprocess, sys, tempfile

from tests.ops import harness

DIGEST = 'sha256:' + '1' * 64
COMMIT = 'a' * 40
TREE = 'b' * 40
SECRET = 'TEST-ONLY-SECRET_token.value'
MIGRATIONS = {'20260101000000_a.sql': b'select 1;\n', '20260102000000_b.sql': b'select 2;\n'}


def stamp(offset_seconds):
    moment = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=offset_seconds)
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def run_py(*args, stdin=None, env=None):
    return subprocess.run([sys.executable, '-I', *map(str, args)], input=stdin, capture_output=True, encoding='utf-8',
                          errors='replace', env=env)


class Host:
    def __init__(self, test, pg_db='techwoman', env=None):
        self.ops = harness.StagedOps(pg_db)
        self.env = dict(env or {})
        test.addCleanup(self.ops.cleanup)
        self.state_dir = self.ops.host / 'state'
        self.work = self.ops.host / 'work'
        self.mig = self.work / 'drizzle'
        self.mig.mkdir(parents=True)
        for name, data in MIGRATIONS.items():
            (self.mig / name).write_bytes(data)

    def facts(self, authorized=-3600, expires=3600):
        return {
            'tested_head': COMMIT, 'tested_tree': TREE, 'base_main': 'c' * 40,
            'ci': {'run_id': '1', 'conclusion': 'success', 'head_sha': COMMIT, 'tree': TREE},
            'gates': {'GATE-001': 'green', 'GATE-002': 'green', 'GATE-003': 'green'},
            'window': {'decision_ref': 'dec-1', 'authorized_at': stamp(authorized), 'expires_at': stamp(expires),
                       'measured_seconds': 900},
            'recovery_evidence_sha256': 'd' * 64, 'rpo_declared': 'ate 24h (dump diario)',
        }

    def seal(self, facts=None):
        facts_path = self.work / 'facts.json'
        facts_path.write_text(json.dumps(facts or self.facts()))
        done = run_py(self.ops.ops / 'manifest.py', 'seal', '--facts', facts_path, '--migrations-dir', self.mig,
                      '--ops-dir', self.ops.ops, '--out', self.state_dir / 'candidate.json')
        assert done.returncode == 0, done.stderr
        os.chmod(self.state_dir / 'candidate.json', 0o644)
        return json.loads((self.state_dir / 'candidate.json').read_text())

    def cutover(self, *args, stdin=None):
        env = dict(os.environ, TW_FAKE_DIR=harness._posix(self.ops.fake), TW_FAKE_LOG=str(self.work / 'cutover-calls.jsonl'),
                   **self.env)
        return run_py(self.ops.ops / 'cutover.py', *args, stdin=stdin, env=env)

    def migrations(self):
        return json.loads(run_py(self.ops.ops / 'manifest.py', 'migrations', self.mig).stdout)

    def deploy_request(self, **changes):
        migrations = self.migrations()
        fields = {'header': 'TWDEPLOY/2', 'op': 'deploy', 'digest': DIGEST, 'commit': COMMIT, 'tree': TREE,
                  'aggregate': migrations['aggregate_sha256'], 'count': str(migrations['count']), 'token': SECRET}
        fields.update(changes)
        return ''.join(fields[k] + '\n' for k in ('header', 'op', 'digest', 'commit', 'tree', 'aggregate', 'count',
                                                   'token'))

    def deploy(self, **changes):
        return self.ops.run(self.deploy_request(**changes))


IMAGE_REF = 'ghcr.io/dellanio/tech-woman@' + DIGEST
IMAGE_FILES = ['/app/server.js', '/tools/scripts/email-worker.ts', '/tools/scripts/migration/migrate.ts',
               '/tools/drizzle/20260101000000_a.sql', '/tools/node_modules/drizzle-orm/index.js']


def _good_image(host, commit=COMMIT):
    from tests.ops.test_manifest import make_tar
    fake = host.ops.fake
    (fake / 'inspect').write_bytes(('arm64|linux|%s\n' % commit).encode())
    (fake / 'fs.txt').write_bytes(('\n'.join(IMAGE_FILES) + '\n').encode())
    (fake / 'drizzle.tar').write_bytes(make_tar([('./', None, 'dir')] + [('./' + n, d, 'file') for n, d in MIGRATIONS.items()]))
    for stale in ('grep.rc', 'inspect.rc', 'login.rc', 'pull.rc'):
        (fake / stale).unlink(missing_ok=True)


def _verify_image(host, ref=IMAGE_REF, commit=COMMIT, aggregate=None, count=None, flags=()):
    migrations = host.migrations()
    return host.ops.run('', script='verify-image.sh',
                        args=[*flags, ref, commit, aggregate or migrations['aggregate_sha256'],
                              count or str(migrations['count'])])


Host.good_image = _good_image
Host.verify_image = _verify_image


ORIGINAL_IMAGE = 'ghcr.io/dellanio/tech-woman@sha256:' + '0' * 64
ORIGINAL_IP = '10.0.0.7'
NOW_FIXED = '2026-10-23T12:00:00Z'


def _staged(host):
    """Candidate sealed, marker prepared and a staged image recorded, through the library (no SSH, no docker)."""
    import hashlib
    candidate = host.seal(host.facts(**getattr(host, 'window', {})))
    cutover = harness.load_ops_module('cutover')
    sealed = hashlib.sha256((host.state_dir / 'candidate.json').read_bytes()).hexdigest()
    state = cutover.State.create(host.state_dir, sealed, NOW_FIXED)
    state.transition('prepared', NOW_FIXED, staged={'digest': DIGEST, 'release_commit': COMMIT,
                                                    'release_tree': TREE, 'at': NOW_FIXED})
    fake = host.ops.fake
    (fake / 'container-inspect').write_bytes(('%s|%s\n' % (ORIGINAL_IMAGE, ORIGINAL_IP)).encode())
    (fake / 'ps').write_bytes(b'tech-woman\nother-service\n')
    (fake / 'timers').write_bytes(b'0 timers listed.\n')
    (fake / 'crontab').write_bytes(b'# no entries\n')
    host.write_inventory(sealed)
    return candidate, state


INVENTORY_WRITERS = [{'id': 'tech-woman', 'kind': 'container'}, {'id': 'tech-woman-mailer', 'kind': 'container'},
                     {'id': 'tech-woman-backup.service', 'kind': 'systemd-unit'},
                     {'id': 'root-crontab-sync', 'kind': 'cron'}, {'id': 'pgadmin-operator-session', 'kind': 'external'}]


def _write_inventory(host, sealed, **changes):
    """Operator's closed inventory of every SQLite writer for this candidate (fixed path in the state dir)."""
    inventory = {'schema': 1, 'candidate_sha256': sealed, 'complete': True, 'decision_ref': 'dec-1',
                 'writers': [dict(w) for w in INVENTORY_WRITERS]}
    inventory.update(changes)
    path = host.state_dir / 'writers-inventory.json'
    path.write_text(json.dumps(inventory))
    os.chmod(path, 0o644)
    return inventory


def _sqlite(host, wal=True):
    from tests.ops.test_snapshot import synthetic_db
    path = host.ops.host / 'app/dados/tech-woman.db'
    return path, synthetic_db(path, wal=wal)


def _calls(host):
    log = host.work / 'cutover-calls.jsonl'
    if not log.exists():
        return []
    return [json.loads(line) for line in log.read_bytes().decode().splitlines() if line]


def _log_text(host):
    log = host.work / 'cutover-calls.jsonl'
    return log.read_bytes().decode() if log.exists() else ''


def source_digest(db_path):
    """Contract of freeze.db_sha256: sha256 of the database file followed by its WAL (empty if absent)."""
    import hashlib
    db_path = pathlib.Path(db_path)
    wal = pathlib.Path(str(db_path) + '-wal')
    return hashlib.sha256(db_path.read_bytes() + (wal.read_bytes() if wal.exists() else b'')).hexdigest()


def _frozen(host, quiet_seconds=1):
    candidate, state = _staged(host)
    db = host.ops.host / 'app/dados/tech-woman.db'
    state.transition('frozen', NOW_FIXED, freeze={
        'at': NOW_FIXED, 'cutoff_at': NOW_FIXED, 'quiet_seconds': quiet_seconds, 'ip': ORIGINAL_IP,
        'original_container': 'tech-woman-sqlite-original', 'original_image': ORIGINAL_IMAGE,
        'db_sha256': source_digest(db) if db.exists() else '0' * 64,
        'writers_checked': ['app-container', 'mailer-containers', 'timers', 'cron', 'file-handles', 'quiet-window']})
    return candidate, state


def _snapshotted(host):
    """Frozen host whose database was snapshotted: A/B copies in private/, source files read-only."""
    import os, stat
    candidate, state = _frozen(host)
    snap = harness.load_ops_module('snapshot')
    private = host.state_dir / 'private'
    private.mkdir()
    first = snap.backup(host.ops.host / 'app/dados/tech-woman.db', private / '4-A.db')
    second = snap.backup(host.ops.host / 'app/dados/tech-woman.db', private / '4-B.db')
    for suffix in ('', '-wal', '-shm'):
        path = host.ops.host / ('app/dados/tech-woman.db' + suffix)
        if path.exists():
            os.chmod(path, os.stat(path).st_mode & ~0o222)
    state.transition('snapshotted', NOW_FIXED, snapshot={
        'sha256': first['checksum'], 'a_digest': first['file_sha256'], 'b_digest': second['file_sha256'],
        'counts_public': first['counts'], 'file_a': '4-A.db', 'file_b': '4-B.db', 'immutable': False, 'at': NOW_FIXED})
    return candidate, state


def _imported(host):
    candidate, state = _snapshotted(host)
    state.transition('imported', NOW_FIXED, **{'import': {'source_checksum': state.data['snapshot']['sha256'],
                                                          'report_pass': True, 'run_id': 'r', 'at': NOW_FIXED}})
    return candidate, state


OLD_PG_DIGEST = 'sha256:' + 'a' * 64
OLD_PG_IMAGE = 'ghcr.io/dellanio/tech-woman@' + OLD_PG_DIGEST
NEW_DIGEST = 'sha256:' + '2' * 64


def _pg_open(host, last_good=OLD_PG_DIGEST, known=(OLD_PG_DIGEST,), schema_aggregate=None):
    """Host already on PostgreSQL (pg_write_open) running OLD_PG_IMAGE; the next release is NEW_DIGEST."""
    from tests.ops.test_snapshot import synthetic_db
    db_path = host.ops.host / 'app/dados/tech-woman.db'
    if not db_path.exists():
        synthetic_db(db_path, wal=False).close()
    candidate, state = _imported(host)
    state.transition('activated', NOW_FIXED, activation={'digest': OLD_PG_DIGEST, 'container': 'tech-woman-web-pg', 'at': NOW_FIXED})
    state.transition('smoke_ok', NOW_FIXED)
    aggregate = schema_aggregate or candidate['migrations']['aggregate_sha256']
    state.transition('pg_write_open', NOW_FIXED, known_pg_images=list(known), last_good_pg_image=last_good,
                     schema_migrations={'aggregate_sha256': aggregate},
                     first_pg_write={'at': None, 'kind': None, 'baseline': {}})
    (host.ops.fake / 'container-inspect').write_bytes(('%s|%s\n' % (OLD_PG_IMAGE, ORIGINAL_IP)).encode())
    (host.ops.fake / 'dump.bytes').write_bytes(b'PGDMP-synthetic-test-dump')
    (host.ops.fake / 'inspect.tech-woman-mailer').write_bytes(b'false' + bytes([10]))  # mailer not running after stop
    return candidate, state


Host.write_inventory = _write_inventory
Host.pg_open = _pg_open
Host.imported = _imported
Host.snapshotted = _snapshotted
Host.frozen = _frozen
Host.cutover_log_text = _log_text
Host.staged = _staged
Host.sqlite = _sqlite
Host.cutover_calls = _calls
