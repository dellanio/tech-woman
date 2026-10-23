"""S12 host items (T18): they stay PENDING until the operator registers readback evidence bound to the sealed candidate;
preflight re-hashes every evidence file and decides pass/fail from its CONTENT with fixed rules (never from a
self-declared verdict). Hermetic fakes only; the SQL checks themselves are proven on PostgreSQL 16 in
tests/ops/pg/test_preflight_pg.py."""
import datetime, hashlib, json, os, unittest

from tests.ops import harness
from tests.ops.hostfixture import Host, run_py

HOST_IDS = ['PF-PG-PORT', 'PF-PGADMIN-TLS', 'PF-PGADMIN-COOKIE', 'PF-PGADMIN-RATE', 'PF-PGADMIN-CONN',
            'PF-BACKUP-DAILY', 'PF-RESTORE', 'PF-NGINX-REDACT', 'PF-NO-SHARED-TOUCH']
PROBE = 'twprobe' + '0' * 37
COOKIE_SECRET = 'TEST-ONLY-pgadmin-session-value'
NOW = datetime.datetime.now(datetime.timezone.utc)


def stamp(hours_ago=1):
    return (NOW - datetime.timedelta(hours=hours_ago)).strftime('%Y-%m-%dT%H:%M:%SZ')


def listing(newest_hours_ago=2, count=7, newest_size=4096):
    epoch = NOW.timestamp() - 3600  # collected one hour ago
    lines = ['%.0f %d techwoman-%02d.dump' % (epoch - (newest_hours_ago + 24 * i) * 3600, newest_size if i == 0 else 4000, i)
             for i in range(count)]
    return '\n'.join(lines) + '\n'


GOOD = {
    'ss-ltn.txt': 'LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:*\nLISTEN 0 511 0.0.0.0:443 0.0.0.0:*\n',
    'pgadmin-headers.txt': ('HTTP/2 200\nstrict-transport-security: max-age=31536000\n'
                            'set-cookie: pga4_session=%s; Expires=x; Secure; HttpOnly; Path=/; SameSite=Lax\n' % COOKIE_SECRET),
    'pgadmin-burst.txt': '\n'.join(['401'] * 18 + ['429'] * 7) + '\n',
    'pgadmin-servers.json': json.dumps({'Servers': {'1': {'Name': 'techwoman', 'Username': 'techwoman_beatriz',
                                                          'Host': 'postgres', 'Port': 5432, 'MaintenanceDB': 'techwoman'}}}),
    'backup-listing.txt': listing(),
    'backup-toc.txt': ';\n; Archive created at 2026-10-23\n;     dbname: techwoman\n;     TOC Entries: 812\n',
    'nginx-T.txt': ('log_format tw_redacted ...;\nserver {\n server_name tech-woman.dellanio.com;\n'
                    ' include /etc/nginx/snippets/tech-woman-redact-server.conf;\n}\n'),
    'nginx-readback.txt': '203.0.113.9 - - [23/Oct/2026] "GET /api/state/[redacted] HTTP/2.0" 200 12 "-" "curl"\n',
    'shared-before.txt': '%s  /etc/nginx/conf.d/dellanio.conf\n' % ('a' * 64),
    'shared-after.txt': '%s  /etc/nginx/conf.d/dellanio.conf\n' % ('a' * 64),
}
FILES = {'PF-PG-PORT': ['ss-ltn.txt'], 'PF-PGADMIN-TLS': ['pgadmin-headers.txt'],
         'PF-PGADMIN-COOKIE': ['pgadmin-headers.txt'], 'PF-PGADMIN-RATE': ['pgadmin-burst.txt'],
         'PF-PGADMIN-CONN': ['pgadmin-servers.json'], 'PF-BACKUP-DAILY': ['backup-listing.txt', 'backup-toc.txt'],
         'PF-NGINX-REDACT': ['nginx-T.txt', 'nginx-readback.txt'],
         'PF-NO-SHARED-TOUCH': ['shared-before.txt', 'shared-after.txt']}
SQL_OK = json.dumps({cid: {'bad': 0} for cid in ['PF-ROLE-FLAGS', 'PF-ROLE-MEMBER', 'PF-PUBLIC-SCHEMA', 'PF-PUBLIC-FUNC',
                                                  'PF-DEFPRIV', 'PF-ROLE-LIMITS', 'PF-OTHER-DB', 'PF-HBA']})
MATRIX_OK = 'psql:<stdin>:317: NOTICE:  MATRIX OK: 581 negações por privilégio executadas, 18 execuções permitidas, 46 verificações de catálogo/efeito\n'


class PreflightHostTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.host.seal()
        self.sealed = hashlib.sha256((self.host.state_dir / 'candidate.json').read_bytes()).hexdigest()
        (self.host.ops.fake / 'exec.out').write_bytes(SQL_OK.encode())
        (self.host.ops.fake / 'exec.err').write_bytes(MATRIX_OK.encode())
        self.evidence = self.host.state_dir / 'evidence'

    def register(self, files=None, items=None, candidate=None, collected=None, raw=None):
        """What the operator does after collecting readback on the host: copy the files, record their hashes."""
        files = dict(GOOD, **(files or {}))
        self.evidence.mkdir(exist_ok=True)
        for name, body in files.items():
            (self.evidence / name).write_bytes(body.encode('utf-8'))
        register = {'schema': 1, 'candidate_sha256': candidate or self.sealed, 'items': {
            cid: {'collected_at': collected or stamp(), 'files': {n: hashlib.sha256(files[n].encode()).hexdigest()
                                                                  for n in names}}
            for cid, names in FILES.items() if items is None or cid in items}}
        path = self.host.state_dir / 'host-evidence.json'
        path.write_text(raw if raw is not None else json.dumps(register))
        os.chmod(path, 0o644)

    def preflight(self, *args):
        env = dict(os.environ, TW_FAKE_DIR=harness._posix(self.host.ops.fake),
                   TW_FAKE_LOG=str(self.host.work / 'cutover-calls.jsonl'))
        return run_py(self.host.ops.ops / 'preflight.py', 'run', *args, env=env)

    def statuses(self, done):
        return {c['id']: c['status'] for c in json.loads(done.stdout)['checks']}


class PendingByDefaultTests(PreflightHostTestCase):
    def test_without_evidence_every_host_item_is_pending_and_nothing_passes_by_declaration(self):
        done = self.preflight()
        self.assertEqual(done.returncode, 88, done.stderr)
        self.assertEqual({k: v for k, v in self.statuses(done).items() if k in HOST_IDS}, {k: 'pending' for k in HOST_IDS})
        # a register that only SAYS pass is not evidence
        self.register(raw=json.dumps({'schema': 1, 'candidate_sha256': self.sealed,
                                      'items': {'PF-PG-PORT': {'status': 'pass'}}}))
        done = self.preflight()
        self.assertNotEqual(self.statuses(done)['PF-PG-PORT'], 'pass')

    def test_complete_good_evidence_and_good_sql_pass_everything_but_restore_without_a_dump(self):
        self.register()
        done = self.preflight()
        statuses = self.statuses(done)
        self.assertEqual({k: v for k, v in statuses.items() if k != 'PF-RESTORE'}, {k: 'pass' for k in statuses if k != 'PF-RESTORE'})
        self.assertEqual(statuses['PF-RESTORE'], 'pending')
        self.assertEqual(done.returncode, 88)
        self.assertNotIn(COOKIE_SECRET, done.stdout + done.stderr)
        self.assertNotIn('dellanio.conf', done.stdout + done.stderr)
        self.assertNotIn(str(self.host.state_dir), done.stdout + done.stderr)


class EvidenceIntegrityTests(PreflightHostTestCase):
    def test_tampered_foreign_stale_or_unsafe_evidence_never_passes(self):
        cases = {
            'file changed after registration': ('tamper', 'fail'),
            'evidence of another candidate': ('candidate', 'fail'),
            'collected more than 7 days ago': ('stale', 'pending'),
            'collected in the future': ('future', 'pending'),
            'evidence file missing': ('missing', 'fail'),
            'path traversal in a file name': ('traversal', 'fail'),
            'register is not JSON': ('garbage', 'fail'),
        }
        for name, (how, expected) in cases.items():
            with self.subTest(name=name):
                self.setUp()
                if how == 'candidate':
                    self.register(candidate='f' * 64)
                elif how == 'stale':
                    self.register(collected=stamp(hours_ago=24 * 8))
                elif how == 'future':
                    self.register(collected=stamp(hours_ago=-2))
                elif how == 'garbage':
                    self.register(raw='{not json')
                elif how == 'traversal':
                    self.register(raw=json.dumps({'schema': 1, 'candidate_sha256': self.sealed, 'items': {
                        'PF-PG-PORT': {'collected_at': stamp(), 'files': {'../candidate.json': 'a' * 64}}}}))
                else:
                    self.register()
                    if how == 'tamper':
                        (self.evidence / 'ss-ltn.txt').write_text('LISTEN 0 4096 127.0.0.1:5432 0.0.0.0:*\n# edited\n')
                    if how == 'missing':
                        (self.evidence / 'ss-ltn.txt').unlink()
                done = self.preflight()
                self.assertEqual(self.statuses(done)['PF-PG-PORT'], expected, done.stdout)
                self.assertNotEqual(done.returncode, 0)
                self.assertNotIn('candidate.json', done.stdout)


class EvidenceContentTests(PreflightHostTestCase):
    def test_each_readback_is_judged_by_its_content(self):
        cases = [
            ('PF-PG-PORT', {'ss-ltn.txt': 'LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:*\n'}),
            ('PF-PG-PORT', {'ss-ltn.txt': 'LISTEN 0 4096 [::]:5432 [::]:*\n'}),
            ('PF-PG-PORT', {'ss-ltn.txt': ''}),
            ('PF-PGADMIN-TLS', {'pgadmin-headers.txt': 'HTTP/1.1 200 OK\nset-cookie: s=x; Secure; HttpOnly\n'}),
            ('PF-PGADMIN-COOKIE', {'pgadmin-headers.txt': 'HTTP/2 200\nstrict-transport-security: max-age=1\nset-cookie: s=x; HttpOnly\n'}),
            ('PF-PGADMIN-COOKIE', {'pgadmin-headers.txt': 'HTTP/2 200\nstrict-transport-security: max-age=1\n'}),
            ('PF-PGADMIN-RATE', {'pgadmin-burst.txt': '\n'.join(['401'] * 30) + '\n'}),
            ('PF-PGADMIN-RATE', {'pgadmin-burst.txt': '429\n'}),
            ('PF-PGADMIN-CONN', {'pgadmin-servers.json': json.dumps({'Servers': {'1': {'Username': 'postgres'}}})}),
            ('PF-PGADMIN-CONN', {'pgadmin-servers.json': '{broken'}),
            ('PF-BACKUP-DAILY', {'backup-listing.txt': listing(newest_hours_ago=30)}),
            ('PF-BACKUP-DAILY', {'backup-listing.txt': listing(count=3)}),
            ('PF-BACKUP-DAILY', {'backup-listing.txt': listing(newest_size=0)}),
            ('PF-BACKUP-DAILY', {'backup-toc.txt': ';     dbname: otherapp\n'}),
            ('PF-NGINX-REDACT', {'nginx-readback.txt': '"GET /api/state/%s HTTP/2.0" 200\n' % PROBE}),
            ('PF-NGINX-REDACT', {'nginx-T.txt': 'server { server_name tech-woman.dellanio.com; }\n'}),
            ('PF-NO-SHARED-TOUCH', {'shared-after.txt': '%s  /etc/nginx/conf.d/dellanio.conf\n' % ('b' * 64)}),
            ('PF-NO-SHARED-TOUCH', {'shared-before.txt': '', 'shared-after.txt': ''}),
        ]
        for cid, files in cases:
            with self.subTest(check=cid, files=sorted(files)):
                self.setUp()
                self.register(files=files)
                done = self.preflight()
                statuses = self.statuses(done)
                self.assertEqual(statuses[cid], 'fail', done.stdout)
                self.assertEqual(done.returncode, 87)
                self.assertNotIn(PROBE, done.stdout + done.stderr)


class InputTests(PreflightHostTestCase):
    def test_only_run_and_a_plain_dump_name_are_accepted(self):
        (self.host.ops.host / 'backups' / 'x.dump').write_bytes(b'PGDMP')
        for args in (['run', '--sql', 'select 1'], ['run', '--restore-dump'], ['run', '--restore-dump', '../x.dump'],
                     ['run', '--restore-dump', 'x.dump;id'], ['run', '--restore-dump', '$(id).dump'], ['exec'], []):
            with self.subTest(args=args):
                env = dict(os.environ, TW_FAKE_DIR=harness._posix(self.host.ops.fake),
                           TW_FAKE_LOG=str(self.host.work / 'cutover-calls.jsonl'))
                done = run_py(self.host.ops.ops / 'preflight.py', *args, env=env)
                self.assertEqual(done.returncode, 64, done.stderr)
                self.assertEqual(self.host.cutover_calls(), [])


if __name__ == '__main__':
    unittest.main()
