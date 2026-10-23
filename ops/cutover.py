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

    @classmethod
    def create(cls, directory, candidate_sha256, now):
        directory = pathlib.Path(directory)
        if (directory / 'state.json').exists():
            raise StateError(75, 'state already exists')
        data = {'schema': 1, 'seq': 1, 'prev_sha256': '0' * 64, 'phase': 'prepared',
                'candidate_sha256': candidate_sha256}
        state_bytes = _dump(data)
        entry = {'seq': 1, 'phase': 'prepared', 'from': None, 'at': now, 'state_sha256': _sha256(state_bytes),
                 'prev_entry_sha256': '0' * 64}
        with open(directory / 'journal.jsonl', 'ab') as journal:
            journal.write((json.dumps(entry, sort_keys=True) + '\n').encode('utf-8'))
        (directory / 'state.json').write_bytes(state_bytes)
        return cls(directory, data)

    @classmethod
    def load(cls, directory):
        directory = pathlib.Path(directory)
        return cls(directory, json.loads((directory / 'state.json').read_text(encoding='utf-8')))
