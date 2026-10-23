#!/usr/bin/env python3
"""Operator-side cutover state (marker + journal) and the read-only deploy gate. Stdlib only.

The state file is root-owned and written only by this tool. The journal is a consistency record
(sequence + links between entries) that detects torn or mismatched writes; it is NOT a cryptographic
protection against root and must not be described as one.
"""
import contextlib, datetime, hashlib, json, os, pathlib, re, stat, sys


class StateError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _dump(obj):
    return (json.dumps(obj, indent=2, sort_keys=True) + '\n').encode('utf-8')


@contextlib.contextmanager
def exclusive(directory):
    """Non-blocking exclusive lock on <dir>/state.lock; a second writer gets exit 66 instead of waiting."""
    handle = open(pathlib.Path(directory) / 'state.lock', 'a+b')
    try:
        try:
            if os.name == 'nt':
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise StateError(66, 'another writer holds the state lock')
        yield
    finally:
        handle.close()


def _fsync_directory(directory):
    if os.name == 'nt':
        return
    descriptor = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


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


class Policy:
    """Who must own the marker files and how private they must be.

    Production (the deploy gate and the operator CLI) always uses the real lstat and STRICT; the injected
    lstat exists only for the Python API used by tests. UNCHECKED is for unit tests of the state machine.
    """

    def __init__(self, owner_uid=0, check_mode=True, lstat=os.lstat):
        self.owner_uid = owner_uid
        self.check_mode = check_mode
        self.lstat = lstat


STRICT = Policy()
UNCHECKED = Policy(owner_uid=None, check_mode=False)


def _check_ownership(directory, policy):
    for path, directory_like in ((directory, True), (directory / 'state.json', False),
                                 (directory / 'journal.jsonl', False)):
        try:
            info = policy.lstat(path)
        except OSError:
            raise StateError(70, 'state marker or journal missing or unreadable')
        wanted = stat.S_ISDIR if directory_like else stat.S_ISREG
        if not wanted(info.st_mode):
            raise StateError(70, '%s is not a plain %s' % (path.name or 'state dir', 'directory' if directory_like else 'file'))
        if policy.owner_uid is not None and info.st_uid != policy.owner_uid:
            raise StateError(70, '%s has the wrong owner' % path.name)
        forbidden = 0o077 if directory_like else 0o177
        if policy.check_mode and info.st_mode & forbidden:
            raise StateError(70, '%s has a permissive mode' % path.name)


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
        with exclusive(self.dir):
            # Write-ahead: the journal entry is durable before the state is replaced. A crash or error in
            # between leaves the two disagreeing, and load() then fails closed (exit 70).
            with open(self.dir / 'journal.jsonl', 'ab') as journal:
                journal.write((json.dumps(entry, sort_keys=True) + '\n').encode('utf-8'))
                journal.flush()
                os.fsync(journal.fileno())
                os.chmod(self.dir / 'journal.jsonl', 0o600)
            temporary = self.dir / ('.state.%d.tmp' % os.getpid())
            try:
                with open(temporary, 'wb') as handle:
                    handle.write(state_bytes)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.chmod(temporary, 0o600)
                os.replace(temporary, self.dir / 'state.json')
            finally:
                if temporary.exists():
                    temporary.unlink()
            _fsync_directory(self.dir)
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
    def load(cls, directory, policy=STRICT):
        """Read the marker; any unreadable, malformed, inconsistent or badly owned state is exit 70."""
        directory = pathlib.Path(directory)
        _check_ownership(directory, policy)
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


HERE = pathlib.Path(__file__).resolve().parent
PATH_KEYS = {'PATH', 'TW_LOCK_FILE', 'TW_STATE_DIR', 'TW_APP_DIR', 'TW_PYTHON', 'TW_STATE_OWNER_UID',
             'TW_STATE_MODE_CHECK'}


def read_paths():
    """Parse the installed paths.env (KEY=value or KEY='value'); never sourced, unknown keys are an error."""
    values = {}
    try:
        lines = (HERE / 'paths.env').read_text(encoding='utf-8').splitlines()
    except OSError:
        raise StateError(70, 'paths.env missing')
    for line in lines:
        if not line.strip() or line.startswith('#'):
            continue
        key, _, value = line.partition('=')
        if key not in PATH_KEYS:
            raise StateError(70, 'paths.env has an unknown key')
        values[key] = value[1:-1] if len(value) >= 2 and value[0] == value[-1] == "'" else value
    if not {'TW_STATE_DIR', 'TW_STATE_OWNER_UID', 'TW_STATE_MODE_CHECK'} <= set(values):
        raise StateError(70, 'paths.env is incomplete')
    return values


def _policy(paths):
    return Policy(owner_uid=int(paths['TW_STATE_OWNER_UID']), check_mode=paths['TW_STATE_MODE_CHECK'] == '1')


def _now():
    return datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def _manifest():
    sys.path.insert(0, str(HERE))
    try:
        import manifest
    finally:
        sys.path.remove(str(HERE))
    return manifest


def _sealed_candidate(paths, manifest):
    """The candidate.json installed by the operator, checked against this very installation."""
    try:
        candidate = manifest.load_candidate(pathlib.Path(paths['TW_STATE_DIR']) / 'candidate.json')
        package = manifest.ops_package(HERE)
    except manifest.ManifestError as error:
        raise StateError(error.code, str(error))
    if package['files'] != candidate['ops_package']['files']:
        raise StateError(65, 'installed ops package differs from the sealed candidate')
    return candidate


def cmd_prepare(paths):
    manifest = _manifest()
    candidate = _sealed_candidate(paths, manifest)
    now = _now()
    window = candidate['window']
    if not window['authorized_at'] <= now < window['expires_at']:
        raise StateError(73, 'outside the authorised window')
    state_dir = pathlib.Path(paths['TW_STATE_DIR'])
    digest = _sha256((state_dir / 'candidate.json').read_bytes())
    State.create(state_dir, digest, now)
    print(json.dumps({'phase': 'prepared', 'candidate_sha256': digest}))


def cmd_status(paths):
    state = State.load(paths['TW_STATE_DIR'], _policy(paths))
    print(json.dumps({'phase': state.phase, 'seq': state.seq, 'candidate_sha256': state.candidate_sha256}))


GATE_FLAGS = ['digest', 'release-commit', 'release-tree', 'migrations-aggregate', 'migrations-count']


def cmd_gate(paths, flags):
    """Read-only decision for deploy.sh: may this request proceed, and as which operation?"""
    manifest = _manifest()
    state = State.load(paths['TW_STATE_DIR'], _policy(paths))
    candidate = _sealed_candidate(paths, manifest)
    sealed = _sha256((pathlib.Path(paths['TW_STATE_DIR']) / 'candidate.json').read_bytes())
    if sealed != state.candidate_sha256:
        raise StateError(70, 'candidate.json is not the one recorded by prepare')
    operation = {'prepared': 'stage', 'pg_write_open': 'release'}.get(state.phase)
    if operation is None:
        raise StateError(75, 'phase %s does not allow deploy' % state.phase)
    if flags['release-tree'] != candidate['tested_tree']:
        raise StateError(71, 'release tree is not the tested tree')
    migrations = candidate['migrations']
    if flags['migrations-aggregate'] != migrations['aggregate_sha256'] \
            or flags['migrations-count'] != str(migrations['count']):
        raise StateError(72, 'migrations differ from the sealed candidate')
    window = candidate['window']
    if operation == 'stage' and not window['authorized_at'] <= _now() < window['expires_at']:
        raise StateError(73, 'outside the authorised window')
    print(json.dumps({'gate': 'ok', 'op': operation, 'phase': state.phase}))


def cmd_phase(paths):
    """Phase for the probe: never fails, so an unreadable marker is reported rather than hidden."""
    try:
        print(State.load(paths['TW_STATE_DIR'], _policy(paths)).phase)
    except StateError:
        print('unreadable')


COMMANDS = {'prepare': cmd_prepare, 'status': cmd_status, 'phase': cmd_phase}


def main(argv):
    try:
        if len(argv) > 2 and argv[1] == 'gate':
            pairs = argv[2:]
            flags = {pairs[i][2:]: pairs[i + 1] for i in range(0, len(pairs) - 1, 2)}
            if len(pairs) % 2 or sorted(flags) != sorted(GATE_FLAGS):
                print('usage: cutover.py gate --digest D --release-commit C ...', file=sys.stderr)
                return 64
            cmd_gate(read_paths(), flags)
            return 0
        if len(argv) != 2 or argv[1] not in COMMANDS:
            print('usage: cutover.py {%s|gate}' % '|'.join(sorted(COMMANDS)), file=sys.stderr)
            return 64
        COMMANDS[argv[1]](read_paths())
        return 0
    except StateError as error:
        print('cutover: %s' % error, file=sys.stderr)
        return error.code


if __name__ == '__main__':
    sys.exit(main(sys.argv))
