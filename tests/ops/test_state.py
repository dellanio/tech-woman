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


if __name__ == '__main__':
    unittest.main()
