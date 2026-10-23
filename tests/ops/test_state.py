import json, os, pathlib, tempfile, unittest
from unittest import mock

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


class LoadIntegrityTests(StateTestCase):
    def prepared_twice(self):
        state = self.create()
        state.transition('frozen', NOW)
        state.transition('snapshotted', NOW)
        return state

    def edit_state(self, **changes):
        path = self.dir / 'state.json'
        data = json.loads(path.read_text())
        data.update(changes)
        path.write_text(json.dumps(data, indent=2, sort_keys=True) + '\n')

    def edit_journal(self, function):
        path = self.dir / 'journal.jsonl'
        entries = [json.loads(l) for l in path.read_text().splitlines()]
        function(entries)
        path.write_text(''.join(json.dumps(e, sort_keys=True) + '\n' for e in entries))

    def test_load_fails_closed_with_70_on_any_inconsistency(self):
        def unlink(name):
            return lambda: (self.dir / name).unlink()

        def write(name, text):
            return lambda: (self.dir / name).write_text(text)

        def entry(index, **changes):
            return lambda: self.edit_journal(lambda entries: entries[index].update(changes))

        cases = {
            'state missing': unlink('state.json'),
            'journal missing': unlink('journal.jsonl'),
            'state not json': write('state.json', '{'),
            'state not an object': write('state.json', '[]'),
            'journal empty': write('journal.jsonl', ''),
            'journal garbage': write('journal.jsonl', 'not json\n'),
            'unknown phase': lambda: self.edit_state(phase='bogus'),
            'seq is bool': lambda: self.edit_state(seq=True),
            'schema is 2': lambda: self.edit_state(schema=2),
            'unknown field': lambda: self.edit_state(surprise=1),
            'candidate sha malformed': lambda: self.edit_state(candidate_sha256='abc'),
            'state phase edited without journal': lambda: self.edit_state(phase='imported'),
            'state seq edited without journal': lambda: self.edit_state(seq=9),
            'state prev link edited': lambda: self.edit_state(prev_sha256='1' * 64),
            'journal tail dropped': lambda: self.edit_journal(lambda entries: entries.pop()),
            'journal middle entry altered': entry(1, at='2030-01-01T00:00:00Z'),
            'journal sequence gap': entry(1, seq=5),
            'journal impossible transition': entry(1, phase='activated'),
            'journal first entry has a source': entry(0, **{'from': 'prepared'}),
        }
        for name, damage in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                self.dir = pathlib.Path(tmp)
                self.prepared_twice()
                self.assertEqual(cutover.State.load(self.dir).phase, 'snapshotted')
                damage()
                with self.assertRaises(cutover.StateError) as caught:
                    cutover.State.load(self.dir)
                self.assertEqual(caught.exception.code, 70, name)


class DurabilityTests(StateTestCase):
    def test_commit_fsyncs_the_journal_and_the_state_and_replaces_atomically(self):
        state = self.create()
        synced, replaced = [], []
        real_fsync, real_replace = os.fsync, os.replace
        with mock.patch.object(cutover.os, 'fsync', side_effect=lambda fd: (synced.append(fd), real_fsync(fd))[1]), \
                mock.patch.object(cutover.os, 'replace',
                                  side_effect=lambda a, b: (replaced.append((str(a), str(b))), real_replace(a, b))[1]):
            state.transition('frozen', NOW)
        self.assertGreaterEqual(len(synced), 2)
        self.assertEqual([pathlib.Path(b).name for _, b in replaced], ['state.json'])
        self.assertNotEqual(pathlib.Path(replaced[0][0]).name, 'state.json')
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ['journal.jsonl', 'state.json', 'state.lock'])

    def test_failure_while_replacing_the_state_interrupts_and_leaves_a_load_error(self):
        state = self.create()
        before = (self.dir / 'state.json').read_bytes()
        with mock.patch.object(cutover.os, 'replace', side_effect=OSError('disk full')):
            with self.assertRaises(OSError):
                state.transition('frozen', NOW)
        self.assertEqual((self.dir / 'state.json').read_bytes(), before)
        self.assertEqual(sorted(p.name for p in self.dir.iterdir()), ['journal.jsonl', 'state.json', 'state.lock'])
        with self.assertRaises(cutover.StateError) as caught:
            cutover.State.load(self.dir)
        self.assertEqual(caught.exception.code, 70)

    def test_a_second_writer_is_refused_while_the_lock_is_held(self):
        state = self.create()
        with cutover.exclusive(self.dir):
            with self.assertRaises(cutover.StateError) as caught:
                state.transition('frozen', NOW)
        self.assertEqual(caught.exception.code, 66)
        state.transition('frozen', NOW)
        self.assertEqual(cutover.State.load(self.dir).phase, 'frozen')


if __name__ == '__main__':
    unittest.main()
