"""SCHEMA-UPG (D-049) on a REAL PostgreSQL 16 (own disposable cluster, see cluster.py).

The database is built like production: bootstrap-local.sql + agenda-privileges.sql as administrator, the 29 migrations
before D-048 by the NON-superuser migrator, product data, and then the host's manual state (Beatriz DML revoked by the
administrator, default_transaction_read_only=on). The marker is pg_write_open with the 29-migration aggregate. Then
`cutover.py schema-upgrade` applies migration 30 through the REAL migrator of this checkout (docker stays the hermetic
fake; psql/pg_dump inside the "PG container" and node inside the "migrator container" are real).
"""
import hashlib, json, os, pathlib, secrets, shutil, subprocess, tempfile, unittest

from tests.ops import harness
from tests.ops.hostfixture import Host
from tests.ops.pg.cluster import Cluster
from tests.ops.test_manifest import make_tar

cutover = harness.load_ops_module('cutover')
ROOT = pathlib.Path(__file__).resolve().parents[3]
OLD_AGGREGATE = '5313dfd6ccc4c425a6837719e6402197f0abbac1052c854e4ecca77e13f92eeb'
NEW_AGGREGATE = '843ee22bb845267d711a5dce46b9b877d5e586dbf2be4dfbc992fd9c0a8cf7d6'
READ_ONLY = '20261026140000_beatriz_read_only.sql'
NEW_TREE = '9' * 40
NEW_COMMIT = '8' * 40
IMAGE = 'ghcr.io/dellanio/tech-woman@sha256:' + '3' * 64
ALIEN = 'techwoman_alien_su'
FIXTURE = """
insert into app_user(id,email,status) values (gen_random_uuid(),'p1@example.invalid','active');
insert into participant(email,goal,moment,interests,skills,area,token_hash,consent_version,user_id,active)
  select u.email,'growth','working','["dados"]','["codigo"]','dados',md5(u.email)||md5(u.email),'v1',u.id,true from app_user u;
insert into mentor(email,trajectory,specialties,availability,capacity,active,display_name)
  values ('m1@example.invalid','t','["dados"]','a',2,true,'Mentora');
insert into topic(slug,name,active) values ('tema-su','Tema',true);
insert into mentor_topic(mentor_id,topic_id,position) select m.id,t.id,1 from mentor m, topic t;
insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status)
  select id, now()+interval '30 days', now()+interval '30 days 1 hour', 5, 'open' from mentor_topic;
insert into enrollment(participant_id,cohort_id,status) select p.id, c.id, 'active' from participant p, cohort c;
"""
# What the operator did by hand on the host (D-048): the editor's DML out, every new login session read-only.
HOST_MANUAL = """
revoke insert, update, delete, truncate, references, trigger on all tables in schema public from techwoman_beatriz;
revoke all on all sequences in schema public from techwoman_beatriz;
alter role techwoman_beatriz in database %s set default_transaction_read_only = on;
"""
COUNTS = ("select json_build_object('app_user',(select count(*) from app_user),'participant',(select count(*) from participant),"
          "'mentor',(select count(*) from mentor),'topic',(select count(*) from topic),'cohort',(select count(*) from cohort),"
          "'enrollment',(select count(*) from enrollment),'match',(select count(*) from match),"
          "'audit_event',(select count(*) from audit_event))")
BEATRIZ_WRITES = """
select count(*) from pg_class c where c.relnamespace in ('public'::regnamespace,'internal'::regnamespace)
 and ((c.relkind in ('r','v') and (has_table_privilege('techwoman_beatriz', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE')
       or has_any_column_privilege('techwoman_beatriz', c.oid, 'INSERT, UPDATE')))
   or (c.relkind = 'S' and has_sequence_privilege('techwoman_beatriz', c.oid, 'USAGE, UPDATE')))
"""
READ_ONLY_SETTING = ("select count(*) from pg_db_role_setting s join pg_database d on d.oid = s.setdatabase "
                     "where s.setrole = 'techwoman_beatriz'::regrole and d.datname = current_database() "
                     "and 'default_transaction_read_only=on' = any(s.setconfig)")


class SchemaUpgradePgTests(unittest.TestCase):
    def setUp(self):
        self.cluster = Cluster()
        self.version = self.cluster.ensure()
        self.addCleanup(self.cluster.psql, 'postgres', 'drop role if exists %s' % ALIEN)
        self.db = self.cluster.create_database('techwoman_su')
        self.addCleanup(self.cluster.drop_database, self.db)
        env = dict(self.cluster.env(), MIGRATOR_PASSWORD=secrets.token_hex(12), RUNTIME_PASSWORD=secrets.token_hex(12),
                   MAILER_PASSWORD=secrets.token_hex(12))
        for script in ('scripts/migration/bootstrap-local.sql', 'scripts/migration/agenda-privileges.sql'):
            done = subprocess.run(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', self.db, '-f', script], cwd=ROOT,
                                  env=env, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr[-500:])
        self.cluster.psql('postgres', "do $$ begin if not exists (select 1 from pg_roles where rolname='backup_techwoman') "
                                      "then create role backup_techwoman login; end if; end $$; "
                                      "alter role backup_techwoman bypassrls; grant pg_read_all_data to backup_techwoman")
        self.node = shutil.which('node')
        self.assertIsNotNone(self.node, 'node no PATH do teste (o migrador real roda com ele)')
        self.migrator_url = 'postgresql://techwoman_migrator@%s:%d/%s' % (self.cluster.host, self.cluster.port, self.db)
        # /tools of the image: the real migrator and node_modules of this checkout, drizzle/ as the image carries it
        self.tools = pathlib.Path(tempfile.mkdtemp(prefix='tw-su-tools-'))
        self.addCleanup(shutil.rmtree, self.tools)
        (self.tools / 'drizzle').mkdir()
        for name in ('scripts', 'node_modules'):
            (self.tools / name).symlink_to(ROOT / name, target_is_directory=True)
        # the rehearsal is the 29 -> 30 release (PR #7); later migrations (31, AJUSTE-INSCRICAO) belong to their own release
        self.real = sorted(p for p in (ROOT / 'drizzle').glob('*.sql') if p.name <= READ_ONLY)
        self.assertEqual((len(self.real), self.real[-1].name), (30, READ_ONLY))
        for path in self.real[:29]:
            (self.tools / 'drizzle' / path.name).write_bytes(path.read_bytes())
        self.migrate(LOCAL_ROLE_SETUP='1')  # 29 migrations by the migrator role, as the cutover left the host
        self.q(FIXTURE)
        self.assertNotEqual(self.q(BEATRIZ_WRITES), '0')  # WP-003 gave the editor DML (column grants included)
        self.q(HOST_MANUAL % self.db)
        self.assertEqual((self.q(BEATRIZ_WRITES), self.q(READ_ONLY_SETTING)), ('0', '1'))
        self.host = Host(self, pg_db=self.db, env=dict(self.cluster.env(), MIGRATION_DATABASE_URL=self.migrator_url,
                                                        TW_FAKE_REPO=str(self.tools), TW_FAKE_NODE=self.node))
        for stale in self.host.mig.glob('*.sql'):
            stale.unlink()
        for path in self.real[:29]:
            (self.host.mig / path.name).write_bytes(path.read_bytes())
        self.host.pg_open()
        self.assertEqual(self.state().data['schema_migrations'], {'aggregate_sha256': OLD_AGGREGATE})
        for name in ('pg-passthrough', 'node-passthrough'):
            (self.host.ops.fake / name).write_bytes(b'')
        # PR #7: migration 30 appended, new candidate sealed, the release image pulled (it carries the 30 files)
        for target in (self.host.mig, self.tools / 'drizzle'):
            (target / READ_ONLY).write_bytes(self.real[-1].read_bytes())
        facts = self.host.facts()
        facts['tested_tree'] = facts['ci']['tree'] = NEW_TREE
        facts['tested_head'] = facts['ci']['head_sha'] = NEW_COMMIT
        self.candidate = self.host.seal(facts)
        self.assertEqual(self.candidate['migrations']['aggregate_sha256'], NEW_AGGREGATE)
        fake = self.host.ops.fake
        (fake / 'inspect').write_bytes(('arm64|linux|%s\n' % NEW_COMMIT).encode())
        (fake / 'fs.txt').write_bytes(b'/app/server.js\n/tools/scripts/email-worker.ts\n/tools/scripts/migration/migrate.ts\n')
        (fake / 'drizzle.tar').write_bytes(make_tar([('./', None, 'dir')] + [('./' + p.name, p.read_bytes(), 'file')
                                                                            for p in sorted((self.tools / 'drizzle').glob('*.sql'))]))

    def q(self, sql):
        return self.cluster.psql(self.db, sql).strip()

    def migrate(self, **env):
        done = subprocess.run([self.node, '--import', 'tsx', 'scripts/migration/migrate.ts'], cwd=self.tools,
                              capture_output=True, text=True, env=dict(os.environ, MIGRATION_DATABASE_URL=self.migrator_url, **env))
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)

    def state(self):
        return cutover.State.load(self.host.state_dir, cutover.UNCHECKED)

    def catalog(self):
        return json.loads(self.q(cutover.CATALOG_SQL))

    def upgrade(self):
        done = self.host.cutover('schema-upgrade', '--image', IMAGE)
        self.assertNotIn('example.invalid', done.stdout + done.stderr)
        return done

    def gate(self):
        return self.host.cutover('gate', '--digest', IMAGE.split('@')[1], '--release-commit', NEW_COMMIT, '--release-tree',
                                 NEW_TREE, '--migrations-aggregate', NEW_AGGREGATE, '--migrations-count', '30')

    def assert_upgraded(self, before):
        files = self.candidate['migrations']['files']
        self.assertEqual(self.catalog(), [[f['name'], f['sha256']] for f in files])  # all 30 rows, checksum == manifest
        state = self.state()
        self.assertEqual((state.phase, state.seq), ('pg_write_open', before.seq + 1))
        self.assertEqual(state.data['schema_migrations'], {'aggregate_sha256': NEW_AGGREGATE})
        self.assertEqual(state.candidate_sha256,
                         hashlib.sha256((self.host.state_dir / 'candidate.json').read_bytes()).hexdigest())
        self.assertEqual((self.q(BEATRIZ_WRITES), self.q(READ_ONLY_SETTING)), ('0', '1'))
        self.assertEqual(self.q("select has_table_privilege('techwoman_beatriz','public.topic','SELECT')"), 't')
        gate = self.gate()
        self.assertEqual(gate.returncode, 0, gate.stderr)
        self.assertEqual(json.loads(gate.stdout)['op'], 'release')

    def test_upgrade_29_to_30_on_the_host_state_keeps_the_data_and_opens_the_new_gate(self):
        before, counts = self.state(), self.q(COUNTS)
        self.assertEqual(self.host.cutover('rebind').returncode, 72)  # D-049: the dead end being fixed
        self.assertEqual(self.gate().returncode, 70)                  # the new candidate is not recorded
        self.assertEqual(len(self.catalog()), 29)
        done = self.upgrade()
        self.assertEqual(done.returncode, 0, done.stderr)
        report = json.loads(done.stdout)
        self.assertEqual((report['applied'], report['resumed']), ([READ_ONLY], False))
        dump = self.host.ops.host / 'backups' / report['backup']
        self.assertTrue(dump.read_bytes().startswith(b'PGDMP'), 'real custom-format pg_dump by the backup role')
        self.assertEqual(self.q(COUNTS), counts)
        self.assert_upgraded(before)
        upgraded = self.state()
        again = self.upgrade()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(json.loads(again.stdout)['schema_upgrade'], 'already-applied')
        self.assertEqual(self.state().seq, upgraded.seq)
        self.assertEqual(sorted(p.name for p in dump.parent.iterdir()), [dump.name])
        self.evidence('happy', {'postgres': self.version, 'report': report, 'counts': json.loads(counts),
                                'catalog_rows': len(self.catalog()), 'repeat': json.loads(again.stdout)})

    def test_an_alien_grant_keeps_the_migration_fail_closed_until_the_operator_removes_it(self):
        before = self.state()
        self.cluster.psql('postgres', "do $$ begin if not exists (select 1 from pg_roles where rolname='%s') "
                                      "then create role %s nologin; end if; end $$" % (ALIEN, ALIEN))
        self.q('grant usage on schema public to %s; grant update (name) on public.topic to %s with grant option; set role %s; '
               'grant update (name) on public.topic to techwoman_beatriz' % (ALIEN, ALIEN, ALIEN))
        refused = self.upgrade()
        self.assertEqual(refused.returncode, 83, refused.stderr)
        self.assertIn('pre-schema-upgrade-', refused.stderr)
        self.assertEqual(len(self.catalog()), 29)  # the migrator rolled back
        self.assertEqual(self.state().seq, before.seq)
        self.assertEqual(self.state().data['schema_migrations'], {'aggregate_sha256': OLD_AGGREGATE})
        self.assertEqual(self.gate().returncode, 70)
        self.q('set role %s; revoke update (name) on public.topic from techwoman_beatriz' % ALIEN)
        done = self.upgrade()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assert_upgraded(before)
        self.evidence('alien-grant', {'refused_exit': refused.returncode, 'refused_stderr': refused.stderr.strip(),
                                      'after_removal': json.loads(done.stdout)})

    def test_a_migrator_that_committed_before_the_marker_was_written_is_resumed(self):
        before = self.state()
        self.migrate()  # crash window: migration 30 committed, the marker still holds the 29-migration aggregate
        done = self.upgrade()
        self.assertEqual(done.returncode, 0, done.stderr)
        report = json.loads(done.stdout)
        self.assertEqual((report['resumed'], report['backup']), (True, None))
        self.assertFalse([c for c in self.host.cutover_calls() if 'pg_dump' in c['args'] or 'scripts/migration/migrate.ts' in c['args']])
        self.assert_upgraded(before)
        self.evidence('resume', {'report': report})

    def evidence(self, name, data):
        directory = os.environ.get('SCHEMA_UPG_EVIDENCE')
        if directory:
            pathlib.Path(directory, 'pg-%s.json' % name).write_text(json.dumps(data, indent=1, sort_keys=True) + '\n')


if __name__ == '__main__':
    unittest.main()
