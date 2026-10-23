#!/usr/bin/env python3
"""Operator-side cutover state (marker + journal) and the read-only deploy gate. Stdlib only.

The state file is root-owned and written only by this tool. The journal is a consistency record
(sequence + links between entries) that detects torn or mismatched writes; it is NOT a cryptographic
protection against root and must not be described as one.
"""
import hashlib, json, pathlib, sys


class StateError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _dump(obj):
    return (json.dumps(obj, indent=2, sort_keys=True) + '\n').encode('utf-8')


ZERO = '0' * 64
TRANSITIONS = {
    ('prepared', 'prepared'): 'stage by deploy.sh',
    ('prepared', 'frozen'): 'operator freeze',
    ('frozen', 'snapshotted'): 'operator snapshot',
    ('snapshotted', 'imported'): 'operator import-verify',
    ('imported', 'activated'): 'operator activate',
    ('activated', 'smoke_ok'): 'operator smoke',
    ('smoke_ok', 'pg_write_open'): 'operator open-writes',
    ('frozen', 'aborted_pre_write'): 'abort before any PG write',
    ('snapshotted', 'aborted_pre_write'): 'abort before any PG write',
    ('imported', 'aborted_pre_write'): 'abort before any PG write',
    ('activated', 'recovering'): 'operator recover',
    ('smoke_ok', 'recovering'): 'operator recover',
    ('pg_write_open', 'recovering'): 'operator recover',
    ('pg_write_open', 'pg_write_open'): 'release by deploy.sh',
}


class State:
    def __init__(self, directory, data):
        self.dir = pathlib.Path(directory)
        self.data = data

    @property
    def phase(self):
        return self.data['phase']

    @property
    def seq(self):
        return self.data['seq']

    @property
    def candidate_sha256(self):
        return self.data['candidate_sha256']

    def _last_entry_sha(self):
        journal = self.dir / 'journal.jsonl'
        lines = journal.read_bytes().splitlines(keepends=True) if journal.exists() else []
        return _sha256(lines[-1]) if lines else ZERO

    def _commit(self, data, previous_phase, now):
        state_bytes = _dump(data)
        entry = {'seq': data['seq'], 'phase': data['phase'], 'from': previous_phase, 'at': now,
                 'state_sha256': _sha256(state_bytes), 'prev_entry_sha256': data['prev_sha256']}
        with open(self.dir / 'journal.jsonl', 'ab') as journal:
            journal.write((json.dumps(entry, sort_keys=True) + '\n').encode('utf-8'))
        (self.dir / 'state.json').write_bytes(state_bytes)
        self.data = data

    @classmethod
    def create(cls, directory, candidate_sha256, now):
        directory = pathlib.Path(directory)
        if (directory / 'state.json').exists():
            raise StateError(75, 'state already exists')
        state = cls(directory, None)
        state._commit({'schema': 1, 'seq': 1, 'prev_sha256': state._last_entry_sha(), 'phase': 'prepared',
                       'candidate_sha256': candidate_sha256}, None, now)
        return state

    @classmethod
    def load(cls, directory):
        directory = pathlib.Path(directory)
        return cls(directory, json.loads((directory / 'state.json').read_text(encoding='utf-8')))

    def transition(self, target, now):
        if (self.phase, target) not in TRANSITIONS:
            raise StateError(75, 'transition %s -> %s is not allowed' % (self.phase, target))
        data = dict(self.data, seq=self.seq + 1, prev_sha256=self._last_entry_sha(), phase=target)
        self._commit(data, self.phase, now)
