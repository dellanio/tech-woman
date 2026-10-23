import json, pathlib, tempfile, unittest

from tests.ops import harness

cutover = harness.load_ops_module('cutover')
NOW = '2026-10-23T12:30:00Z'
CANDIDATE_SHA = 'd' * 64


class StateTestCase(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.dir = pathlib.Path(self._tmp.name)

    def create(self):
        return cutover.State.create(self.dir, CANDIDATE_SHA, NOW)


class CreateAndLoadTests(StateTestCase):
    def test_create_writes_prepared_state_and_a_matching_journal_line(self):
        state = self.create()
        self.assertEqual((state.phase, state.seq, state.candidate_sha256), ('prepared', 1, CANDIDATE_SHA))
        loaded = cutover.State.load(self.dir)
        self.assertEqual((loaded.phase, loaded.seq, loaded.candidate_sha256), ('prepared', 1, CANDIDATE_SHA))
        journal = [json.loads(l) for l in (self.dir / 'journal.jsonl').read_text().splitlines()]
        self.assertEqual([(j['seq'], j['phase'], j['from']) for j in journal], [(1, 'prepared', None)])

    def test_create_refuses_to_overwrite_an_existing_state(self):
        self.create()
        with self.assertRaises(cutover.StateError) as caught:
            self.create()
        self.assertEqual(caught.exception.code, 75)


PHASES = ['prepared', 'frozen', 'snapshotted', 'imported', 'activated', 'smoke_ok', 'pg_write_open',
          'aborted_pre_write', 'recovering']
ALLOWED = {
    ('prepared', 'prepared'), ('prepared', 'frozen'), ('frozen', 'snapshotted'), ('snapshotted', 'imported'),
    ('imported', 'activated'), ('activated', 'smoke_ok'), ('smoke_ok', 'pg_write_open'),
    ('frozen', 'aborted_pre_write'), ('snapshotted', 'aborted_pre_write'), ('imported', 'aborted_pre_write'),
    ('activated', 'recovering'), ('smoke_ok', 'recovering'), ('pg_write_open', 'recovering'),
    ('pg_write_open', 'pg_write_open'),
}


def path_to(target):
    queue, seen = [['prepared']], {'prepared'}
    while queue:
        path = queue.pop(0)
        if path[-1] == target:
            return path
        for a, b in sorted(ALLOWED):
            if a == path[-1] and b not in seen:
                seen.add(b)
                queue.append(path + [b])
    raise AssertionError('unreachable phase %s' % target)


class TransitionTests(StateTestCase):
    def state_in(self, phase):
        state = self.create()
        for step in path_to(phase)[1:]:
            state.transition(step, NOW)
        return state

    def test_only_the_documented_transitions_are_accepted_and_others_exit_75(self):
        self.assertEqual(set(cutover.TRANSITIONS), ALLOWED)
        for a in PHASES:
            for b in PHASES:
                with self.subTest(source=a, target=b), tempfile.TemporaryDirectory() as tmp:
                    self.dir = pathlib.Path(tmp)
                    state = self.state_in(a)
                    seq = state.seq
                    if (a, b) in ALLOWED:
                        state.transition(b, NOW)
                        self.assertEqual((state.phase, state.seq), (b, seq + 1))
                        self.assertEqual(cutover.State.load(self.dir).phase, b)
                    else:
                        with self.assertRaises(cutover.StateError) as caught:
                            state.transition(b, NOW)
                        self.assertEqual(caught.exception.code, 75)
                        self.assertEqual((state.phase, state.seq), (a, seq))
                        self.assertEqual(cutover.State.load(self.dir).seq, seq)

    def test_unknown_target_phase_is_refused(self):
        state = self.create()
        with self.assertRaises(cutover.StateError) as caught:
            state.transition('pg_write_openn', NOW)
        self.assertEqual(caught.exception.code, 75)


if __name__ == '__main__':
    unittest.main()
