import unittest

from tests.ops import harness
from tests.ops.hostfixture import Host

cutover = harness.load_ops_module('cutover')
ORIGINAL = 'tech-woman-sqlite-original'
POST_ACTIVATION = ['activated', 'smoke_ok', 'pg_write_open', 'recovering']
# operator commands that are the legitimate next step of each phase (they have their own tests)
VALID_NEXT = {'activated': {'smoke'}, 'smoke_ok': {'open-writes'}, 'pg_write_open': set(), 'recovering': set()}
COMMANDS = {
    'prepare': [], 'freeze': ['--quiet-seconds', '1'], 'snapshot': [], 'import-verify': [],
    'activate': [], 'smoke': [], 'open-writes': [], 'abort': ['--reason', 'operator-decision'],
}


class NoSqliteFallbackTests(unittest.TestCase):
    def reach(self, host, phase):
        self.addCleanup(host.sqlite()[1].close)
        candidate, state = host.imported()
        path = {'activated': ['activated'], 'smoke_ok': ['activated', 'smoke_ok'],
                'pg_write_open': ['activated', 'smoke_ok', 'pg_write_open'],
                'recovering': ['activated', 'recovering']}[phase]
        for step in path:
            state.transition(step, '2026-10-23T12:00:00Z')

    def test_after_activation_no_operator_command_can_bring_the_sqlite_service_back(self):
        for phase in POST_ACTIVATION:
            host = Host(self)
            self.reach(host, phase)
            for command, extra in COMMANDS.items():
                if command in VALID_NEXT[phase]:
                    continue
                with self.subTest(phase=phase, command=command):
                    done = host.cutover(command, *extra)
                    self.assertEqual(done.returncode, 75, done.stderr)
                    calls = [c for c in host.cutover_calls() if c['cmd'] in ('docker', 'chattr', 'systemctl', 'crontab')]
                    self.assertEqual(calls, [])
                    state = cutover.State.load(host.state_dir, cutover.UNCHECKED)
                    self.assertEqual(state.phase, phase)

    def test_the_transition_table_has_no_edge_from_a_post_activation_phase_to_a_pre_write_one(self):
        for source, target in cutover.TRANSITIONS:
            if source in POST_ACTIVATION:
                self.assertIn(target, {'smoke_ok', 'pg_write_open', 'recovering'}, (source, target))
        self.assertNotIn(ORIGINAL, repr(cutover.TRANSITIONS))


if __name__ == '__main__':
    unittest.main()
