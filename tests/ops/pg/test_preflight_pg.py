"""S12 — preflight T12 against a REAL PostgreSQL 16 (own disposable cluster, see cluster.py).

The database is built like production: bootstrap-local.sql + agenda-privileges.sql as administrator, migrations as
the NON-superuser migrator, grants-local.sql. The operator command `ops/preflight.py run` is the code path under test
(docker is the hermetic fake; the psql it would run inside the PG container is the real one). Every bad state is
created for real and must be detected by its stable id; the preflight itself must change nothing.
"""
import json, os, pathlib, secrets, subprocess, unittest

from tests.ops.hostfixture import Host, run_py
from tests.ops.pg.cluster import Cluster

ROOT = pathlib.Path(__file__).resolve().parents[3]
SQL_IDS = ['PF-ROLE-FLAGS', 'PF-ROLE-MEMBER', 'PF-PUBLIC-SCHEMA', 'PF-PUBLIC-FUNC', 'PF-DEFPRIV', 'PF-COLGRANT',
           'PF-ROLE-LIMITS', 'PF-OTHER-DB', 'PF-HBA']
HOST_IDS = ['PF-PG-PORT', 'PF-PGADMIN-TLS', 'PF-PGADMIN-COOKIE', 'PF-PGADMIN-RATE', 'PF-PGADMIN-CONN',
            'PF-BACKUP-DAILY', 'PF-RESTORE', 'PF-NGINX-REDACT', 'PF-NO-SHARED-TOUCH']
# operator remediation the preflight demands (PUBLIC keeps no USAGE on public; the roles get it explicitly)
REMEDIATION = """
revoke usage on schema public from public;
grant usage on schema public to techwoman_runtime, techwoman_mailer, techwoman_migrator, techwoman_owner, techwoman_beatriz;
"""
SNAPSHOT = """
select json_build_object(
 'settings', (select json_agg(s.setconfig order by s.setrole, s.setdatabase) from pg_db_role_setting s),
 'roles', (select json_agg(row(rolname, rolsuper, rolcreatedb, rolcreaterole, rolcanlogin) order by rolname) from pg_roles),
 'members', (select json_agg(row(roleid, member) order by roleid, member) from pg_auth_members),
 'db_acl', (select json_agg(row(datname, datacl::text) order by datname) from pg_database),
 'ns_acl', (select json_agg(row(nspname, nspacl::text) order by nspname) from pg_namespace),
 'users', (select count(*) from app_user))
"""


class PreflightWorld(unittest.TestCase):
    def setUp(self):
        self.cluster = Cluster()
        self.version = self.cluster.ensure()
        self.db = self.cluster.create_database('techwoman_pf')
        self.addCleanup(self.cluster.drop_database, self.db)
        env = dict(self.cluster.env(), MIGRATOR_PASSWORD=secrets.token_hex(12), RUNTIME_PASSWORD=secrets.token_hex(12),
                   MAILER_PASSWORD=secrets.token_hex(12))
        for script in ('scripts/migration/bootstrap-local.sql', 'scripts/migration/agenda-privileges.sql'):
            done = subprocess.run(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', self.db, '-f', script], cwd=ROOT,
                                  env=env, capture_output=True, text=True)
            self.assertEqual(done.returncode, 0, done.stderr[-500:])
        migrator = 'postgresql://techwoman_migrator@%s:%d/%s' % (self.cluster.host, self.cluster.port, self.db)
        done = subprocess.run(['node', '--import', 'tsx', 'scripts/migration/migrate.ts'], cwd=ROOT, capture_output=True,
                              text=True, env=dict(os.environ, MIGRATION_DATABASE_URL=migrator, LOCAL_ROLE_SETUP='1'))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.host = Host(self, pg_db=self.db, env=self.cluster.env())
        (self.host.ops.fake / 'pg-passthrough').write_bytes(b'')
        self.host.seal()
        # good operator state: limits applied, PUBLIC without USAGE on public, and other databases closed to the
        # techwoman roles by a role-specific pg_hba rule (D-040). PUBLIC keeps its default CONNECT on every other
        # database: the ACL of other services is NEVER changed (ARQUITETURA-EVOLUCAO-POSTGRES.md:49).
        done = subprocess.run(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', self.db, '-f', 'ops/sql/role-limits.sql'],
                              cwd=ROOT, env=self.cluster.env(), capture_output=True, text=True)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.q(REMEDIATION)
        self.neighbour = self.cluster.create_database('tw_pf_neighbour')  # stands for another service's database
        self.addCleanup(self.cluster.drop_database, self.neighbour)
        self.reopened = self.cluster.psql('postgres', "select datname from pg_database where datallowconn and not "
                                                      "datistemplate and datname <> '%s'" % self.db).split()
        self.public_connect = self.cluster.psql('postgres', "select count(*) from pg_database where datallowconn and not "
                                                            "datistemplate and datname <> '%s' and has_database_privilege("
                                                            "'public', oid, 'CONNECT')" % self.db).strip()
        self.assertGreaterEqual(int(self.public_connect), 2)  # postgres + the neighbour: PUBLIC CONNECT left as is
        self.hba = self.cluster.data / 'pg_hba.conf'
        # the pristine pg_hba of the disposable cluster is kept once, so an interrupted run can never leave scram behind
        pristine = self.cluster.data / 'pg_hba.conf.wp005-orig'
        if not pristine.exists():
            pristine.write_bytes(self.hba.read_bytes())
        self.original_hba = pristine.read_bytes()
        self.addCleanup(self.restore_hba)
        self.write_hba(self.isolated_hba())

    def isolated_hba(self, reject=True):
        roles = 'techwoman_runtime,techwoman_mailer,techwoman_beatriz,techwoman_migrator'
        return ('host all postgres 127.0.0.1/32 trust\n'
                'host %s techwoman_migrator 127.0.0.1/32 trust\n'
                'host %s all 127.0.0.1/32 scram-sha-256\n' % (self.db, self.db)
                + ('host all %s 0.0.0.0/0 reject\n' % roles if reject else '')
                + 'host all all 127.0.0.1/32 scram-sha-256\n')

    def write_hba(self, text):
        self.hba.write_bytes(text.encode())
        self.cluster.psql('postgres', 'select pg_reload_conf()')

    def restore_hba(self):
        self.write_hba(self.original_hba.decode())

    def q(self, sql):
        return self.cluster.psql(self.db, sql)

    def preflight(self, *args):
        env = dict(os.environ, TW_FAKE_DIR=str(self.host.ops.fake), TW_FAKE_LOG=str(self.host.work / 'cutover-calls.jsonl'),
                   **self.cluster.env())
        return run_py(self.host.ops.ops / 'preflight.py', 'run', *args, env=env)

    def report(self, done):
        return {item['id']: item for item in json.loads(done.stdout)['checks']}


class SqlChecksTests(PreflightWorld):
    def test_a_correct_database_passes_every_sql_check_and_host_items_stay_pending(self):
        before = self.q(SNAPSHOT)
        done = self.preflight()
        self.assertEqual(done.returncode, 88, done.stderr)  # pending: host evidence was not supplied
        report = self.report(done)
        self.assertEqual({i: report[i]['status'] for i in SQL_IDS}, {i: 'pass' for i in SQL_IDS})
        self.assertEqual({i: report[i]['status'] for i in HOST_IDS}, {i: 'pending' for i in HOST_IDS})
        self.assertEqual(json.loads(done.stdout)['overall'], 'pending')
        self.assertRegex(report['PF-COLGRANT']['detail'], r'^581 denied, 18 allowed, 46 checked$')
        self.assertEqual(self.q(SNAPSHOT), before, 'the preflight changes nothing (the matrix rolls back)')
        for other in self.reopened:
            self.assertNotIn(other, done.stdout)  # neighbour database names never appear

    def test_each_bad_state_is_detected_by_its_stable_id(self):
        cases = [
            ('PF-ROLE-FLAGS', 'alter role techwoman_runtime createdb', 'alter role techwoman_runtime nocreatedb'),
            ('PF-ROLE-MEMBER', 'grant techwoman_runtime to techwoman_beatriz', 'revoke techwoman_runtime from techwoman_beatriz'),
            ('PF-PUBLIC-SCHEMA', 'grant usage on schema internal to public', 'revoke usage on schema internal from public'),
            ('PF-PUBLIC-SCHEMA', 'grant usage on schema public to public', 'revoke usage on schema public from public'),
            ('PF-PUBLIC-FUNC', 'grant execute on function internal.api_legacy_state(text) to public',
             'revoke execute on function internal.api_legacy_state(text) from public'),
            ('PF-DEFPRIV', 'alter default privileges in schema public grant select on tables to public',
             'alter default privileges in schema public revoke select on tables from public'),
            ('PF-COLGRANT', 'grant select (email) on public.participant to techwoman_beatriz',
             'revoke select (email) on public.participant from techwoman_beatriz'),
            ('PF-ROLE-LIMITS', 'alter role techwoman_mailer in database %s reset lock_timeout' % self.db, None),
        ]
        for check, bad, undo in cases:
            with self.subTest(check=check, bad=bad):
                # roles are global to the cluster: the undo always runs, even when an assertion fails
                self.cluster.psql(self.db if 'database postgres' not in bad else 'postgres', bad)
                try:
                    done = self.preflight()
                    self.assertEqual(done.returncode, 87, done.stderr)
                    report = self.report(done)
                    self.assertEqual(report[check]['status'], 'fail', report[check])
                    # the grants matrix (PF-COLGRANT) independently catches several of these too; nothing else may fail
                    self.assertEqual({i for i in SQL_IDS if report[i]['status'] == 'fail'} - {check, 'PF-COLGRANT'}, set())
                    self.assertEqual(json.loads(done.stdout)['overall'], 'fail')
                finally:
                    if undo:
                        self.cluster.psql(self.db if 'database postgres' not in undo else 'postgres', undo)
                    else:
                        subprocess.run(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', self.db, '-f',
                                        'ops/sql/role-limits.sql'], cwd=ROOT, env=self.cluster.env(), check=True,
                                       capture_output=True)
        self.assertEqual(self.preflight().returncode, 88)

    def test_isolation_is_effective_by_hba_without_touching_the_acl_of_other_databases(self):
        acl = self.cluster.psql('postgres', 'select json_agg(row(datname, datacl::text) order by datname) from pg_database')
        done = self.preflight()
        report = self.report(done)
        self.assertEqual(report['PF-OTHER-DB']['status'], 'pass', report['PF-OTHER-DB'])
        self.assertRegex(report['PF-OTHER-DB']['detail'], r'^\d+ role/database connection attempts refused by pg_hba$')
        self.assertEqual(self.cluster.psql('postgres', 'select json_agg(row(datname, datacl::text) order by datname) '
                                                       'from pg_database'), acl, 'the ACL of other databases is untouched')
        self.assertNotIn(self.neighbour, done.stdout + done.stderr)

    def test_an_open_hba_fails_pf_other_db_even_though_the_acl_is_default(self):
        self.write_hba(self.isolated_hba(reject=False))  # roles reach other databases (password prompt, not reject)
        done = self.preflight()
        self.assertEqual(done.returncode, 87, done.stderr)
        report = self.report(done)
        self.assertEqual(report['PF-OTHER-DB']['status'], 'fail', report['PF-OTHER-DB'])
        self.assertRegex(report['PF-OTHER-DB']['detail'], r'not refused by pg_hba')
        self.assertEqual({i for i in SQL_IDS if report[i]['status'] == 'fail'}, {'PF-OTHER-DB'})
        self.assertNotIn(self.neighbour, done.stdout + done.stderr)
        self.write_hba('host all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 trust\n')  # trust: login works
        report = self.report(self.preflight())
        self.assertEqual(report['PF-OTHER-DB']['status'], 'fail', report['PF-OTHER-DB'])

    def test_trust_or_password_authentication_for_the_roles_fails_pf_hba(self):
        self.write_hba('host all postgres 127.0.0.1/32 trust\nhost all all 127.0.0.1/32 trust\n')
        done = self.preflight()
        self.assertEqual(done.returncode, 87, done.stderr)
        self.assertEqual(self.report(done)['PF-HBA']['status'], 'fail')

    def test_an_unreadable_database_fails_every_sql_check_instead_of_passing(self):
        (self.host.ops.fake / 'pg-passthrough').unlink()
        (self.host.ops.fake / 'exec.rc').write_bytes(b'1')
        done = self.preflight()
        self.assertEqual(done.returncode, 87, done.stderr)
        report = self.report(done)
        self.assertEqual({i: report[i]['status'] for i in SQL_IDS}, {i: 'fail' for i in SQL_IDS})


class BackupRoleTests(PreflightWorld):
    def test_the_documented_backup_role_coexists_with_a_green_preflight(self):
        """The pre-release pg_dump needs BYPASSRLS (Agenda tables use RLS); the WP-003 matrix forbids BYPASSRLS on any
        techwoman_* role. The production TW_PG_DUMP_USER must satisfy both."""
        production = dict(line.split('=', 1) for line in (ROOT / 'ops/paths.env').read_text().splitlines()
                          if line and not line.startswith('#'))
        role = production['TW_PG_DUMP_USER']
        self.assertRegex(role, r'^[a-z_][a-z0-9_]*$')
        self.cluster.psql('postgres', "do $$ begin if not exists (select 1 from pg_roles where rolname='%s') then "
                                      "create role %s login bypassrls; end if; end $$; grant pg_read_all_data to %s"
                          % (role, role, role))
        self.addCleanup(self.cluster.psql, 'postgres', 'drop role if exists %s' % role)
        done = self.preflight()
        report = self.report(done)
        self.assertEqual({i: report[i]['status'] for i in SQL_IDS}, {i: 'pass' for i in SQL_IDS}, report['PF-COLGRANT'])
        self.restore_hba()  # the scram-only hba of this world has no password for the synthetic role; dump over trust
        dump = subprocess.run(['pg_dump', '-Fc', '-U', role, '-d', self.db], env=self.cluster.env(), capture_output=True)
        self.assertEqual(dump.returncode, 0, dump.stderr[-300:])
        self.assertTrue(dump.stdout.startswith(b'PGDMP'))


class RestoreCheckTests(PreflightWorld):
    def test_pf_restore_restores_the_newest_daily_dump_in_isolation_and_proves_the_schema(self):
        dump = self.host.ops.host / 'backups' / 'daily-20261023.dump'
        with open(dump, 'wb') as out:
            subprocess.run(['pg_dump', '-Fc', '-d', self.db], stdout=out, check=True, env=self.cluster.env())
        done = self.preflight('--restore-dump', dump.name)
        report = self.report(done)
        self.assertEqual(report['PF-RESTORE']['status'], 'pass', report['PF-RESTORE'])
        self.assertRegex(report['PF-RESTORE']['detail'], r'^restored in isolation: \d+ tables, \d+ rows, schema identical$')
        restored = self.cluster.psql('postgres', "select count(*) from pg_database where datname like '%s_preflight_%%'" % self.db)
        self.assertEqual(restored.strip(), '1')
        self.addCleanup(lambda: [self.cluster.drop_database(n) for n in self.cluster.psql(
            'postgres', "select datname from pg_database where datname like '%s_preflight_%%'" % self.db).split()])
        for bad in ('../state/state.json', 'x;id.dump', '/etc/passwd', 'missing.dump'):
            with self.subTest(bad=bad):
                self.assertEqual(self.preflight('--restore-dump', bad).returncode, 64)


class MatrixCopyTests(unittest.TestCase):
    def test_the_packaged_matrix_is_byte_identical_to_the_wp003_matrix(self):
        self.assertEqual((ROOT / 'ops/sql/agenda-grants-matrix.sql').read_bytes(),
                         (ROOT / 'scripts/migration/agenda-grants-matrix.sql').read_bytes().replace(b'\r\n', b'\n'))


if __name__ == '__main__':
    unittest.main()
