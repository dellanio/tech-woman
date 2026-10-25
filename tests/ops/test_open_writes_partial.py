"""G3-01 / T16 (D-039): a partial publication in open-writes must leave a durable, recoverable phase.

Converted from GATE-003 reproduce-cutover.py (ASSERT_CONTRACT=1). Hermetic Docker fake: proves the CLI routing and the
persisted phase only, never a real container. A failure is injected at every publication step; after each one the
baseline is already durable, recover and record-first-write are accepted, a repeated open-writes resumes without
removing the renamed web, and nothing ever goes back to SQLite.
"""
import json, unittest

from tests.ops import harness
from tests.ops.hostfixture import DIGEST, Host

cutover = harness.load_ops_module('cutover')
IMAGE = 'ghcr.io/dellanio/tech-woman@' + DIGEST
BASELINE = {'participant': 3, 'enrollment': 2, 'match': 1, 'audit_event': 9, 'app_user': 4, 'audit_max_id': 9}
SQLITE_ORIGINAL = 'tech-woman-sqlite-original'


def docker(calls):
    return [c['args'] for c in calls if c['cmd'] == 'docker']


class PartialOpenTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.db, self.writer = self.host.sqlite()
        self.addCleanup(self.writer.close)
        _, state = self.host.imported()
        state.transition('activated', '2026-10-23T12:00:00Z', activation={'digest': DIGEST, 'container': 'tech-woman-web-pg',
                                                                         'at': '2026-10-23T12:00:00Z'})
        state.transition('smoke_ok', '2026-10-23T12:00:00Z')
        (self.host.ops.fake / 'node.out.1').write_bytes((json.dumps(BASELINE) + '\n').encode())

    def state(self):
        return cutover.State.load(self.host.state_dir, cutover.UNCHECKED)

    def break_step(self, name, rc=b'1'):
        (self.host.ops.fake / name).write_bytes(rc)

    def heal(self, name):
        (self.host.ops.fake / name).unlink()

    def assert_never_sqlite(self):
        for args in docker(self.host.cutover_calls()):
            self.assertNotIn(SQLITE_ORIGINAL, args)


class PartialOpenContract(PartialOpenTestCase):
    def test_gate003_reproduction_partial_open_has_an_executable_recovery(self):
        """GATE-003 G3-01: mailer start fails after network-connect + rename."""
        self.break_step('run-d.rc')
        opened = self.host.cutover('open-writes')
        self.assertEqual(opened.returncode, 83, opened.stderr)
        calls = docker(self.host.cutover_calls())
        self.assertTrue(any(a[:2] == ['network', 'connect'] for a in calls))
        self.assertIn(['rename', 'tech-woman-web-pg', 'tech-woman'], calls)
        state = self.state()
        self.assertEqual(state.phase, 'pg_write_opening')
        self.assertEqual(state.data['first_pg_write']['baseline'], BASELINE)
        self.assertEqual(state.data['known_pg_images'], [DIGEST])
        self.assertEqual(state.data['opening']['done'], ['switch'])
        first = self.host.cutover('record-first-write')
        self.assertNotEqual(first.returncode, 75, first.stderr)
        recovered = self.host.cutover('recover', '--mode', 'restart')
        self.assertNotEqual(recovered.returncode, 75, recovered.stderr)
        self.assert_never_sqlite()


class PartialOpenEveryStep(PartialOpenTestCase):
    # (fake file that makes the step fail, expected durable progress after the failure)
    STEPS = [('rm.rc', []), ('rename.rc', []), ('run-d.rc', ['switch']),
             ('exec.rc', ['switch', 'mailer'])]

    def test_failure_at_each_publication_step_leaves_pg_write_opening_with_the_baseline(self):
        for name, progress in self.STEPS:
            with self.subTest(step=name):
                self.setUp()
                self.break_step(name)
                opened = self.host.cutover('open-writes')
                self.assertNotEqual(opened.returncode, 0, name)
                state = self.state()
                self.assertEqual(state.phase, 'pg_write_opening', opened.stderr)
                self.assertEqual(state.data['first_pg_write']['baseline'], BASELINE)
                self.assertEqual(state.data['opening']['done'], progress)
                self.assertIn('pg_write_opening', opened.stderr)
                self.assert_never_sqlite()

    def test_repeated_open_writes_resumes_without_removing_the_renamed_web(self):
        self.break_step('run-d.rc')
        self.assertEqual(self.host.cutover('open-writes').returncode, 83)
        self.heal('run-d.rc')
        before = len(self.host.cutover_calls())
        again = self.host.cutover('open-writes')
        self.assertEqual(again.returncode, 0, again.stderr)
        resumed = docker(self.host.cutover_calls()[before:])
        self.assertEqual([a for a in resumed if a[0] in ('rm', 'rename') or a[:1] == ['network']], [])
        self.assertEqual([a for a in resumed if a[0] == 'run' and '--rm' in a], [])  # baseline is not re-measured
        self.assertTrue(any(a[0] == 'run' and '-d' in a for a in resumed))
        state = self.state()
        self.assertEqual(state.phase, 'pg_write_open')
        self.assertEqual(state.data['first_pg_write']['baseline'], BASELINE)
        self.assertEqual(self.host.cutover('open-writes').returncode, 75)  # nothing to open twice
        self.assert_never_sqlite()

    def test_repeat_after_rename_observed_on_host_but_not_recorded_skips_the_switch(self):
        """Crash between the rename and its record: the host shows the PG image as tech-woman -> no rm/rename."""
        self.break_step('rename.rc')
        self.assertEqual(self.host.cutover('open-writes').returncode, 83)
        self.heal('rename.rc')
        (self.host.ops.fake / 'inspect.tech-woman').write_bytes((IMAGE + '\n').encode())
        before = len(self.host.cutover_calls())
        again = self.host.cutover('open-writes')
        self.assertEqual(again.returncode, 0, again.stderr)
        resumed = docker(self.host.cutover_calls()[before:])
        self.assertEqual([a for a in resumed if a[0] in ('rm', 'rename') or a[:1] == ['network']], [])
        self.assertEqual(self.state().phase, 'pg_write_open')

    def test_failure_before_any_exposure_keeps_smoke_ok(self):
        (self.host.ops.fake / 'node.out.1').write_bytes(b'not json\n')
        opened = self.host.cutover('open-writes')
        self.assertEqual(opened.returncode, 82)
        self.assertEqual(self.state().phase, 'smoke_ok')
        self.assertEqual([a for a in docker(self.host.cutover_calls()) if a[0] in ('rm', 'rename', 'network')], [])

    def test_recover_after_a_partial_open_with_an_unreadable_live_database_fails_closed_85(self):
        """GATE-003 probe follow-up: an empty psql answer is 'not readable' (85, nothing started), never a traceback."""
        self.break_step('run-d.rc')
        self.assertEqual(self.host.cutover('open-writes').returncode, 83)
        before = len(self.host.cutover_calls())
        done = self.host.cutover('recover', '--mode', 'restart')
        self.assertEqual(done.returncode, 85, done.stderr)
        self.assertNotIn('Traceback', done.stderr)
        self.assertEqual([a for a in docker(self.host.cutover_calls()[before:]) if a[0] in ('start', 'run', 'rm', 'rename')], [])
        self.assertEqual(self.state().phase, 'recovering')  # deploys stay denied until a proven recovery
        self.assert_never_sqlite()

    def test_gate_refuses_deploys_while_opening(self):
        self.break_step('run-d.rc')
        self.host.cutover('open-writes')
        self.assertEqual(self.state().phase, 'pg_write_opening')
        self.assertEqual(self.host.deploy().returncode, 75)


if __name__ == '__main__':
    unittest.main()
