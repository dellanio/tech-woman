"""SCHEMA-UPG (D-049): `cutover.py schema-upgrade --image <digest ref>` in pg_write_open.

Hermetic: docker is the fake, the catalogue internal.schema_migration is what the fake psql prints. Only migrations
APPENDED to the recorded set are accepted; the state keeps only the aggregate, so the recorded prefix is found by
aggregate and every catalogue row is confronted. Order: checks -> image -> pg_dump -> migrator -> catalogue -> marker.
"""
import fcntl, hashlib, json, unittest
from unittest.mock import patch

from tests.ops import harness
from tests.ops.hostfixture import Host
from tests.ops.test_manifest import make_tar

cutover = harness.load_ops_module('cutover')
NEW_TREE = '9' * 40
NEW_COMMIT = '8' * 40
IMAGE = 'ghcr.io/dellanio/tech-woman@sha256:' + '3' * 64
EXTRA = ('20260103000000_c.sql', b'select 3;\n')


def rows(files):
    return json.dumps([[f['name'], f['sha256']] for f in files]) + '\n'


class SchemaUpgradeTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.host.pg_open()  # recorded schema: the two fixture migrations (aggregate only)
        self.old = self.host.migrations()['files']
        (self.host.mig / EXTRA[0]).write_bytes(EXTRA[1])
        self.new = self.host.migrations()['files']
        self.image()

    def state(self):
        return cutover.State.load(self.host.state_dir, cutover.UNCHECKED)

    def seal_next(self, tree=NEW_TREE, **window):
        facts = self.host.facts(**window)
        facts['tested_tree'] = facts['ci']['tree'] = tree
        facts['tested_head'] = facts['ci']['head_sha'] = NEW_COMMIT
        return self.host.seal(facts)

    def image(self, commit=NEW_COMMIT, files=None):
        """The pulled image: revision label and /tools/drizzle exactly as the given migrations directory."""
        fake = self.host.ops.fake
        (fake / 'inspect').write_bytes(('arm64|linux|%s\n' % commit).encode())
        (fake / 'fs.txt').write_bytes(b'/app/server.js\n/tools/scripts/email-worker.ts\n/tools/scripts/migration/migrate.ts\n')
        entries = files if files is not None else [(p.name, p.read_bytes()) for p in sorted(self.host.mig.glob('*.sql'))]
        (fake / 'drizzle.tar').write_bytes(make_tar([('./', None, 'dir')] + [('./' + n, d, 'file') for n, d in entries]))

    def catalog(self, *answers):
        """Successive answers of the catalogue read (1 = before, 2 = after the migrator)."""
        for index, files in enumerate(answers, start=1):
            (self.host.ops.fake / ('exec-test-postgres.out.%d' % index)).write_text(rows(files))

    def upgrade(self, *args):
        return self.host.cutover('schema-upgrade', *(args or ('--image', IMAGE)))

    def effects(self):
        """(kind, argv) of every effect: backup, migrator, anything detached; reads are not effects."""
        found = []
        for call in self.host.cutover_calls():
            args = call['args']
            if call['cmd'] != 'docker':
                continue
            if args[:1] == ['exec'] and 'pg_dump' in args:
                found.append('pg_dump')
            elif args[:1] == ['run'] and 'scripts/migration/migrate.ts' in args:
                found.append('migrator')
            elif args[:1] in (['stop'], ['rename'], ['rm'], ['start']) or (args[:1] == ['run'] and '-d' in args):
                found.append(args[0])
        return found

    def backups(self):
        return sorted(p.name for p in (self.host.ops.host / 'backups').iterdir())

    def assert_untouched(self, before):
        state = self.state()
        self.assertEqual((state.seq, state.candidate_sha256, state.data['schema_migrations']),
                         (before.seq, before.candidate_sha256, before.data['schema_migrations']))


class HappyPathTests(SchemaUpgradeTestCase):
    def test_rebind_refuses_the_appended_migration_and_schema_upgrade_records_it(self):
        candidate = self.seal_next()
        before = self.state()
        self.assertEqual(self.host.cutover('rebind').returncode, 72)  # the D-049 dead end this command resolves
        self.catalog(self.old, self.new)
        done = self.upgrade()
        self.assertEqual(done.returncode, 0, done.stderr)
        report = json.loads(done.stdout)
        sealed = hashlib.sha256((self.host.state_dir / 'candidate.json').read_bytes()).hexdigest()
        state = self.state()
        self.assertEqual(state.phase, 'pg_write_open')
        self.assertEqual(state.seq, before.seq + 1)  # exactly one transition
        self.assertEqual(state.candidate_sha256, sealed)
        self.assertEqual(state.data['schema_migrations'], {'aggregate_sha256': candidate['migrations']['aggregate_sha256']})
        self.assertEqual(state.data['known_pg_images'], before.data['known_pg_images'])
        self.assertEqual(state.data['last_good_pg_image'], before.data['last_good_pg_image'])
        self.assertEqual((report['applied'], report['resumed']), ([EXTRA[0]], False))
        self.assertEqual(self.effects(), ['pg_dump', 'migrator'])
        self.assertEqual(self.backups(), [report['backup']])
        self.assertTrue(report['backup'].startswith('pre-schema-upgrade-') and report['backup'].endswith('.dump'))
        calls = [c['args'] for c in self.host.cutover_calls() if c['cmd'] == 'docker']
        image_checked = calls.index(['image', 'inspect', IMAGE, '--format',
                                     '{{.Architecture}}|{{.Os}}|{{index .Config.Labels "org.opencontainers.image.revision"}}'])
        dump = calls.index(['exec', 'test-postgres', 'pg_dump', '-Fc', '-U', 'backup_techwoman', 'techwoman'])
        migrator = [i for i, a in enumerate(calls) if 'scripts/migration/migrate.ts' in a and a[0] == 'run']
        self.assertLess(image_checked, dump)
        self.assertEqual(len(migrator), 1)
        self.assertLess(dump, migrator[0])
        self.assertEqual(['docker'] + calls[migrator[0]], cutover._migrator_argv(self.paths(), IMAGE))  # the existing one-shot
        gate = self.host.cutover('gate', '--digest', IMAGE.split('@')[1], '--release-commit', NEW_COMMIT,
                                 '--release-tree', NEW_TREE, '--migrations-aggregate',
                                 candidate['migrations']['aggregate_sha256'], '--migrations-count', '3')
        self.assertEqual(gate.returncode, 0, gate.stderr)
        self.assertEqual(json.loads(gate.stdout)['op'], 'release')

    def test_a_concurrent_state_writer_cannot_be_overwritten_or_corrupt_the_journal(self):
        self.seal_next()
        before = self.state()
        queries = []

        def catalog(paths):
            queries.append(True)
            if len(queries) == 2:
                self.state().transition('recovering', '2026-10-23T12:00:00Z',
                                        recovery={'mode': 'restart', 'result': 'in-progress'})
            return self.new

        with patch.object(cutover, 'HERE', self.host.ops.ops), patch.object(cutover, '_schema_catalog', catalog):
            with self.assertRaises(cutover.StateError) as refused:
                cutover.cmd_schema_upgrade(self.paths(), {'image': IMAGE})
        self.assertEqual(refused.exception.code, 66)
        after = self.state()  # journal must still load, not just the marker JSON
        self.assertEqual((after.phase, after.seq, after.candidate_sha256),
                         ('recovering', before.seq + 1, before.candidate_sha256))
        self.assertEqual(after.data['schema_migrations'], before.data['schema_migrations'])

    def paths(self):
        values = {}
        for line in (self.host.ops.ops / 'paths.env').read_text().splitlines():
            key, _, value = line.partition('=')
            values[key] = value[1:-1] if value[:1] == "'" else value
        return values

    def test_a_crash_after_the_migrator_committed_resumes_without_running_it_again(self):
        self.seal_next()
        before = self.state()
        self.catalog(self.new, self.new)  # the database already holds the full new candidate, the marker is old
        done = self.upgrade()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)['resumed'], True)
        self.assertEqual(self.effects(), [])  # no new backup, no migrator
        self.assertEqual(self.state().seq, before.seq + 1)

    def test_a_repeat_after_the_marker_was_updated_verifies_and_changes_nothing(self):
        self.seal_next()
        self.catalog(self.old, self.new, self.new)
        self.assertEqual(self.upgrade().returncode, 0)
        after = self.state()
        effects = len(self.effects())
        again = self.upgrade()
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(json.loads(again.stdout)['schema_upgrade'], 'already-applied')
        self.assert_untouched(after)
        self.assertEqual(len(self.effects()), effects)

    def test_a_repeat_whose_catalogue_differs_from_the_recorded_schema_is_refused(self):
        self.seal_next()
        self.catalog(self.old, self.new, self.old)
        self.assertEqual(self.upgrade().returncode, 0)
        self.assertEqual(self.upgrade().returncode, 72)


class RefusalTests(SchemaUpgradeTestCase):
    def refused(self, code, *args):
        before = self.state()
        done = self.upgrade(*args)
        self.assertEqual(done.returncode, code, done.stderr)
        self.assert_untouched(before)
        self.assertEqual(self.effects(), [])
        self.assertEqual(self.backups(), [])
        return done

    def test_the_image_must_be_an_immutable_reference_of_the_repository(self):
        self.seal_next()
        self.catalog(self.old, self.new)
        for args in ((), ('--image', 'ghcr.io/dellanio/tech-woman:latest'),
                     ('--image', 'ghcr.io/other/tech-woman@sha256:' + '3' * 64),
                     ('--image', IMAGE, '--image', IMAGE), ('--image', IMAGE, '--force', '1')):
            with self.subTest(args=args):
                self.refused(64, *(args or ('--image',)))

    def test_phase_other_than_pg_write_open_is_75(self):
        self.seal_next()
        self.catalog(self.old, self.new)
        self.state().transition('recovering', '2026-10-23T12:00:00Z')
        self.refused(75, '--image', IMAGE)

    def test_outside_the_window_is_73(self):
        self.seal_next(authorized=-7200, expires=-3600)
        self.catalog(self.old, self.new)
        self.refused(73, '--image', IMAGE)

    def test_an_edited_migration_is_72(self):
        (self.host.mig / '20260102000000_b.sql').write_bytes(b'select 22;\n')
        self.seal_next()
        self.catalog(self.old, self.new)
        self.refused(72, '--image', IMAGE)

    def test_a_migration_inserted_before_a_recorded_one_is_72(self):
        (self.host.mig / EXTRA[0]).unlink()
        (self.host.mig / '20260101500000_between.sql').write_bytes(b'select 15;\n')
        self.seal_next()
        self.catalog(self.old, self.new)
        self.refused(72, '--image', IMAGE)

    def test_a_removed_migration_is_72(self):
        (self.host.mig / '20260101000000_a.sql').unlink()
        self.seal_next()
        self.catalog(self.old, self.new)
        self.refused(72, '--image', IMAGE)

    def test_no_new_migration_with_another_candidate_is_72_rebind_is_the_tool(self):
        (self.host.mig / EXTRA[0]).unlink()
        self.seal_next()
        self.catalog(self.old)
        self.refused(72, '--image', IMAGE)

    def test_a_catalogue_that_is_not_the_recorded_prefix_is_72(self):
        self.seal_next()
        edited = [dict(self.old[0]), dict(self.old[1], sha256='e' * 64)]
        alien = self.old + [{'name': '20260101500000_alien.sql', 'sha256': 'f' * 64}]
        for catalog in (self.old[:1], edited, alien, self.new + [{'name': '20260104000000_d.sql', 'sha256': 'f' * 64}], []):
            with self.subTest(catalog=[f['name'] for f in catalog]):
                (self.host.ops.fake / 'exec-test-postgres.count').unlink(missing_ok=True)
                self.catalog(catalog)
                self.refused(72, '--image', IMAGE)

    def test_an_unreadable_catalogue_is_83_and_nothing_else_runs(self):
        self.seal_next()
        (self.host.ops.fake / 'exec-test-postgres.rc.1').write_text('2')
        self.refused(83, '--image', IMAGE)

    def test_the_image_is_verified_before_the_backup(self):
        self.seal_next()
        self.catalog(self.old, self.new)
        self.image(commit='7' * 40)  # not the sealed tested head
        self.refused(74, '--image', IMAGE)
        self.image(files=[(p.name, p.read_bytes()) for p in sorted(self.host.mig.glob('*.sql'))][:2])  # old SQL inside
        (self.host.ops.fake / 'exec-test-postgres.count').unlink()
        self.refused(72, '--image', IMAGE)
        self.image(files=[(n, d) for n, d in [(p.name, p.read_bytes()) for p in sorted(self.host.mig.glob('*.sql'))]]
                   [:2] + [(EXTRA[0], b'select 4;\n')])  # same names, other SQL than the seal
        (self.host.ops.fake / 'exec-test-postgres.count').unlink()
        self.refused(72, '--image', IMAGE)
        self.image()
        (self.host.ops.env_dir / 'migrator.env').unlink()
        (self.host.ops.fake / 'exec-test-postgres.count').unlink()
        self.refused(74, '--image', IMAGE)

    def test_another_operation_holding_the_deploy_lock_is_66(self):
        self.seal_next()
        self.catalog(self.old, self.new)
        with open(self.host.ops.host / 'lock/deploy.lock', 'a+b') as handle:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.refused(66, '--image', IMAGE)


class FailureAfterChecksTests(SchemaUpgradeTestCase):
    def test_a_failed_backup_is_79_and_the_migrator_never_runs(self):
        self.seal_next()
        before = self.state()
        self.catalog(self.old, self.new)
        (self.host.ops.fake / 'pgdump.rc').write_text('1')
        done = self.upgrade()
        self.assertEqual(done.returncode, 79, done.stderr)
        self.assertEqual(self.effects(), ['pg_dump'])
        self.assertTrue(all(name.endswith('.failed') for name in self.backups()))
        self.assert_untouched(before)

    def test_an_empty_backup_is_79(self):
        self.seal_next()
        before = self.state()
        self.catalog(self.old, self.new)
        (self.host.ops.fake / 'dump.bytes').write_bytes(b'')
        self.assertEqual(self.upgrade().returncode, 79)
        self.assertEqual(self.effects(), ['pg_dump'])
        self.assert_untouched(before)

    def test_a_failed_migrator_keeps_the_marker_and_the_backup(self):
        self.seal_next()
        before = self.state()
        self.catalog(self.old, self.new)
        (self.host.ops.fake / 'node.rc.1').write_text('1')
        done = self.upgrade()
        self.assertEqual(done.returncode, 83, done.stderr)
        self.assertIn('pre-schema-upgrade-', done.stderr)
        self.assertEqual(self.effects(), ['pg_dump', 'migrator'])
        self.assertEqual(len(self.backups()), 1)
        self.assert_untouched(before)

    def test_a_catalogue_that_is_not_the_full_candidate_after_the_migrator_is_72(self):
        self.seal_next()
        before = self.state()
        self.catalog(self.old, self.old)
        self.assertEqual(self.upgrade().returncode, 72)
        self.assert_untouched(before)


if __name__ == '__main__':
    unittest.main()
