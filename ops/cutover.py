#!/usr/bin/env python3
"""Operator-side cutover state (marker + journal) and the read-only deploy gate. Stdlib only.

The state file is root-owned and written only by this tool. The journal is a consistency record
(sequence + links between entries) that detects torn or mismatched writes; it is NOT a cryptographic
protection against root and must not be described as one.
"""
import hashlib, json, pathlib, re, sys


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


PHASES = {phase for pair in TRANSITIONS for phase in pair}
REQUIRED_KEYS = {'schema', 'seq', 'prev_sha256', 'phase', 'candidate_sha256'}
OPTIONAL_KEYS = {'staged', 'window', 'freeze', 'snapshot', 'import', 'activation', 'known_pg_images',
                 'last_good_pg_image', 'schema_migrations', 'first_pg_write', 'abort'}
JOURNAL_KEYS = {'seq', 'phase', 'from', 'at', 'state_sha256', 'prev_entry_sha256'}
HEX64 = re.compile(r'\A[0-9a-f]{64}\Z')


def _is_int(value):
    return type(value) is int


def _is_hex64(value):
    return type(value) is str and HEX64.match(value) is not None


def _check_state_shape(data):
    if type(data) is not dict or not REQUIRED_KEYS <= set(data) <= REQUIRED_KEYS | OPTIONAL_KEYS:
        raise StateError(70, 'state has an unexpected shape')
    if not (data['schema'] == 1 and _is_int(data['schema']) and _is_int(data['seq']) and data['seq'] >= 1
            and data['phase'] in PHASES and _is_hex64(data['prev_sha256'])
            and _is_hex64(data['candidate_sha256'])):
        raise StateError(70, 'state has invalid values')


def _check_journal(entries, raw_lines, data, state_bytes):
    if not entries:
        raise StateError(70, 'journal is empty')
    previous_sha, previous_phase = ZERO, None
    for index, (entry, line) in enumerate(zip(entries, raw_lines), start=1):
        if type(entry) is not dict or set(entry) != JOURNAL_KEYS or entry['seq'] != index \
                or not _is_int(entry['seq']) or entry['prev_entry_sha256'] != previous_sha \
                or entry['from'] != previous_phase \
                or (previous_phase is not None and (previous_phase, entry['phase']) not in TRANSITIONS):
            raise StateError(70, 'journal entry %d is inconsistent' % index)
        previous_sha, previous_phase = _sha256(line), entry['phase']
    last = entries[-1]
    if last['seq'] != data['seq'] or last['phase'] != data['phase'] or last['state_sha256'] != _sha256(state_bytes) \
            or last['prev_entry_sha256'] != data['prev_sha256']:
        raise StateError(70, 'state does not match the last journal entry')


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
        """Read the marker; any unreadable, malformed or inconsistent state is exit 70 (fail closed)."""
        directory = pathlib.Path(directory)
        try:
            state_bytes = (directory / 'state.json').read_bytes()
            data = json.loads(state_bytes.decode('utf-8'))
            raw_lines = (directory / 'journal.jsonl').read_bytes().splitlines(keepends=True)
            entries = [json.loads(line.decode('utf-8')) for line in raw_lines]
        except (OSError, ValueError):
            raise StateError(70, 'state marker or journal missing or unreadable')
        _check_state_shape(data)
        _check_journal(entries, raw_lines, data, state_bytes)
        return cls(directory, data)

    def transition(self, target, now):
        if (self.phase, target) not in TRANSITIONS:
            raise StateError(75, 'transition %s -> %s is not allowed' % (self.phase, target))
        data = dict(self.data, seq=self.seq + 1, prev_sha256=self._last_entry_sha(), phase=target)
        self._commit(data, self.phase, now)
