"""S14 — full operator rehearsal on REAL data paths: synthetic legacy SQLite -> Backup API snapshots -> the REAL importer
and migrator of this checkout -> PostgreSQL 16 (own disposable cluster) -> first write -> PG-era release with a real
pre-release pg_dump by a read-only backup role -> restore check. Docker, registry, nginx and the host stay hermetic
fakes (tripwires); every `cutover.py`/`deploy.sh` step is the shipped code path, in the documented order.
"""
import hashlib, json, os, pathlib, shutil, sqlite3, subprocess, unittest

from tests.ops import harness
from tests.ops.hostfixture import DIGEST, COMMIT, TREE, Host, IMAGE_REF, ORIGINAL_IMAGE, ORIGINAL_IP, SECRET
from tests.ops.pg.cluster import Cluster
from tests.ops.test_manifest import make_tar

cutover = harness.load_ops_module('cutover')
ROOT = pathlib.Path(__file__).resolve().parents[3]
NEW_DIGEST = 'sha256:' + '2' * 64
LEGACY = """
CREATE TABLE participant(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,goal TEXT NOT NULL,moment TEXT NOT NULL,interests TEXT NOT NULL,skills TEXT NOT NULL,area TEXT,token_hash TEXT UNIQUE NOT NULL,consent_version TEXT NOT NULL,consent_at TEXT NOT NULL);
CREATE TABLE mentor(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,trajectory TEXT NOT NULL,specialties TEXT NOT NULL,availability TEXT NOT NULL,capacity INTEGER NOT NULL,active INTEGER NOT NULL,demo INTEGER NOT NULL,demo_name TEXT);
CREATE TABLE match(id INTEGER PRIMARY KEY AUTOINCREMENT,participant_id INTEGER REFERENCES participant(id),mentor_id INTEGER REFERENCES mentor(id),score INTEGER,reasons TEXT,status TEXT);
CREATE TABLE admin_user(email TEXT PRIMARY KEY,password_hash TEXT,role TEXT);
CREATE TABLE email_attempt(participant_id INTEGER PRIMARY KEY REFERENCES participant(id),status TEXT,provider_id TEXT,updated_at TEXT);
CREATE TABLE choice_email_attempt(participant_id INTEGER PRIMARY KEY REFERENCES participant(id),mentor_id INTEGER REFERENCES mentor(id),status TEXT,provider_id TEXT,updated_at TEXT);
CREATE TABLE event_content(id INTEGER PRIMARY KEY,description TEXT,venue TEXT,agenda TEXT,speakers TEXT,date TEXT,duration TEXT);
"""
PRODUCT_WRITE = """
insert into app_user(id,email,status) values (gen_random_uuid(),'nova@example.invalid','active');
insert into participant(email,goal,moment,interests,skills,area,token_hash,consent_version,user_id,active)
  select email,'growth','working','["dados"]','["codigo"]','dados',md5(email)||md5(email),'v1',id,true from app_user where email='nova@example.invalid';
insert into topic(slug,name,active) values ('tema-ensaio','Tema',true);
insert into mentor_topic(mentor_id,topic_id,position) select (select min(id) from mentor), id, 1 from topic where slug='tema-ensaio';
update mentor set active=true where id=(select min(id) from mentor);
insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status)
  select id, now()+interval '30 days', now()+interval '30 days 1 hour', 5, 'open' from mentor_topic;
insert into enrollment(participant_id,cohort_id,status)
  select p.id, c.id, 'active' from participant p, cohort c where p.email='nova@example.invalid';
"""


def legacy_sqlite(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    c = sqlite3.connect(path)
    c.executescript(LEGACY)
    c.execute('INSERT INTO participant VALUES(?,?,?,?,?,?,?,?,?,?)', (1, 'ana@example.invalid', 'growth', 'working',
              '["dados"]', '["analise"]', 'dados', 'a' * 64, 'v1', '2026-10-01T10:00:00-03:00'))
    c.execute('INSERT INTO mentor VALUES(1,?,?,?,?,?,?,?,?)', ('mentora@example.invalid', 'Trajetoria ficticia',
              '["dados"]', 'texto', 3, 1, 0, None))
    c.execute('INSERT INTO match VALUES(1,1,1,9,?,?)', ('["razao"]', 'approved'))
    c.execute("INSERT INTO event_content VALUES(1,'Encontro sintetico','Recife, PE','Agenda textual','Texto','2026-11-14','2h')")
    c.commit()
    c.close()


class RehearsalTests(unittest.TestCase):
    def setUp(self):
        self.cluster = Cluster()
        self.version = self.cluster.ensure()
        self.db = self.cluster.create_database('techwoman_rh')
        self.addCleanup(self.drop_databases)
        for role in ('techwoman_runtime', 'techwoman_mailer'):
            self.cluster.psql('postgres', "do $$ begin if not exists (select 1 from pg_roles where rolname='%s') "
                                          "then create role %s nologin; end if; end $$" % (role, role))
        # read-only backup role (TW_PG_DUMP_USER) as a first, naive attempt: LOGIN + pg_read_all_data, no BYPASSRLS
        self.cluster.psql('postgres', "do $$ begin if not exists (select 1 from pg_roles where rolname='backup_techwoman') "
                                      "then create role backup_techwoman login; end if; end $$; "
                                      "alter role backup_techwoman nobypassrls; grant pg_read_all_data to backup_techwoman")
        env = dict(self.cluster.env(), MIGRATION_DATABASE_URL=self.cluster.url(self.db), TW_FAKE_REPO=str(ROOT))
        self.host = Host(self, pg_db=self.db, env=env)
        # the candidate's migrations are the real ones of this checkout (what the migrator applies)
        for stale in self.host.mig.glob('*.sql'):
            stale.unlink()
        for real in sorted((ROOT / 'drizzle').glob('*.sql')):
            (self.host.mig / real.name).write_bytes(real.read_bytes().replace(b'\r\n', b'\n'))
        fake = self.host.ops.fake
        for name in ('pg-passthrough', 'node-passthrough'):
            (fake / name).write_bytes(b'')
        self.sqlite = self.host.ops.host / 'app/dados/tech-woman.db'
        legacy_sqlite(self.sqlite)

    def drop_databases(self):
        for name in self.cluster.psql('postgres', "select datname from pg_database where datname like '%s%%'" % self.db).split():
            self.cluster.drop_database(name)

    def image(self, commit=COMMIT):
        fake, files = self.host.ops.fake, sorted(self.host.mig.glob('*.sql'))
        (fake / 'inspect').write_bytes(('arm64|linux|%s\n' % commit).encode())
        (fake / 'fs.txt').write_bytes(('\n'.join(['/app/server.js', '/tools/scripts/email-worker.ts',
                                                   '/tools/scripts/migration/migrate.ts', '/tools/drizzle/' + files[0].name,
                                                   '/tools/node_modules/drizzle-orm/index.js']) + '\n').encode())
        (fake / 'drizzle.tar').write_bytes(make_tar([('./', None, 'dir')] + [('./' + f.name, f.read_bytes(), 'file') for f in files]))

    def step(self, *args, stdin=None, code=0):
        done = self.host.cutover(*args, stdin=stdin)
        self.assertEqual(done.returncode, code, '%s: %s' % (args[0], done.stderr))
        self.assertNotIn('example.invalid', done.stdout + done.stderr)
        self.transcript.append({'step': args[0], 'exit': done.returncode})
        return done

    def deploy(self, digest):
        env = dict(self.cluster.env())
        result = self.host.ops.run(self.host.deploy_request(digest=digest), extra_env=env)
        result.assert_no_tripwire()
        self.assertNotIn(SECRET, result.stdout + result.stderr)
        self.transcript.append({'step': 'deploy.sh', 'exit': result.returncode})
        return result

    def test_cutover_and_a_release_rehearsed_end_to_end_on_sqlite_and_postgres_16(self):
        self.transcript = []
        fake = self.host.ops.fake
        candidate = self.host.seal()
        self.step('prepare')
        sealed = cutover.State.load(self.host.state_dir, cutover.UNCHECKED).candidate_sha256
        self.image()
        staged = self.deploy(DIGEST)
        self.assertEqual(staged.returncode, 0, staged.stderr)
        self.step('register-stage', stdin=staged.stdout)

        (fake / 'container-inspect').write_bytes(('%s|%s\n' % (ORIGINAL_IMAGE, ORIGINAL_IP)).encode())
        (fake / 'ps').write_bytes(b'tech-woman\nother-service\n')
        self.host.write_inventory(sealed)
        self.step('freeze', '--quiet-seconds', '1')
        self.step('snapshot')
        frozen_bytes = self.sqlite.read_bytes()
        self.step('import-verify')
        imported = self.cluster.psql(self.db, "select count(*) from participant where email='ana@example.invalid'").strip()
        self.assertEqual(imported, '1', 'the real importer loaded the snapshot into PostgreSQL')
        self.step('activate')
        self.step('smoke')
        self.step('open-writes')
        baseline = cutover.State.load(self.host.state_dir, cutover.UNCHECKED).data['first_pg_write']['baseline']
        self.assertEqual(baseline['participant'], 1)
        activation_calls = len(self.host.cutover_calls())

        self.cluster.psql(self.db, PRODUCT_WRITE)  # first PostgreSQL write: a reservation through the product triggers
        first = json.loads(self.step('record-first-write').stdout)['first_pg_write']
        self.assertEqual(first['kind'], 'enrollment.create')

        (fake / 'container-inspect').write_bytes(('%s|%s\n' % (IMAGE_REF, ORIGINAL_IP)).encode())
        # real finding: Agenda tables use row-level security, so pg_dump by a role without BYPASSRLS refuses;
        # deploy.sh must stop with 79 BEFORE touching any container
        refused = self.deploy(NEW_DIGEST)
        self.assertEqual(refused.returncode, 79, refused.stderr)
        self.assertEqual([c['args'] for c in refused.calls() if c['cmd'] == 'docker' and (
            c['args'][0] in ('stop', 'rename', 'rm', 'start') or (c['args'][0] == 'run' and '-d' in c['args']))], [])
        self.cluster.psql('postgres', 'alter role backup_techwoman bypassrls')  # the operator's documented fix
        released = self.deploy(NEW_DIGEST)
        self.assertEqual(released.returncode, 0, released.stderr)
        report = json.loads(released.stdout)
        dump = self.host.ops.host / 'backups' / report['attestation']['backup']
        self.assertTrue(dump.read_bytes().startswith(b'PGDMP'), 'a real custom-format pg_dump by the backup role')
        (fake / 'container-inspect').write_bytes(('ghcr.io/dellanio/tech-woman@%s|%s\n' % (NEW_DIGEST, ORIGINAL_IP)).encode())
        self.step('register-release', stdin=released.stdout)
        state = cutover.State.load(self.host.state_dir, cutover.UNCHECKED)
        self.assertEqual((state.phase, state.data['last_good_pg_image']), ('pg_write_open', NEW_DIGEST))
        self.assertEqual(state.data['known_pg_images'], [DIGEST, NEW_DIGEST])

        compared = json.loads(self.step('recover', '--mode', 'compare', '--dump', dump.name).stdout)
        self.assertTrue(compared['equal'], compared)  # nothing was written after the pre-release dump

        journal = [json.loads(l)['phase'] for l in (self.host.state_dir / 'journal.jsonl').read_text().splitlines()]
        self.assertEqual(journal, ['prepared', 'prepared', 'frozen', 'snapshotted', 'imported', 'activated', 'smoke_ok',
                                   'pg_write_open', 'pg_write_open', 'pg_write_open'])
        after = self.host.cutover_calls()[activation_calls:]
        self.assertFalse([c for c in after if 'tech-woman-sqlite-original' in json.dumps(c)], 'SQLite never comes back')
        self.assertEqual([c for c in self.host.cutover_calls() if c['tripwire']], [])
        self.assertEqual(self.sqlite.read_bytes(), frozen_bytes)
        self.assertEqual(os.stat(self.sqlite).st_mode & 0o222, 0)
        evidence = pathlib.Path(os.environ.get('WP005_REHEARSAL_EVIDENCE', '')) if os.environ.get('WP005_REHEARSAL_EVIDENCE') else None
        if evidence:
            evidence.write_text(json.dumps({'postgres': self.version, 'steps': self.transcript, 'journal': journal,
                                            'counts_after_import': baseline, 'first_pg_write_kind': first['kind'],
                                            'release_backup_bytes': dump.stat().st_size, 'compare_equal': compared['equal'],
                                            'tables_compared': compared['tables'], 'rows_compared': compared['rows']}, indent=1))


if __name__ == '__main__':
    unittest.main()
