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
    ('recovering', 'pg_write_open'): 'operator recovery verified on PostgreSQL',
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
                 'last_good_pg_image', 'schema_migrations', 'first_pg_write', 'abort', 'recovery'}
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

    def transition(self, target, now, **updates):
        if (self.phase, target) not in TRANSITIONS:
            raise StateError(75, 'transition %s -> %s is not allowed' % (self.phase, target))
        data = dict(self.data, seq=self.seq + 1, prev_sha256=self._last_entry_sha(), phase=target, **updates)
        self._commit(data, self.phase, now)


HERE = pathlib.Path(__file__).resolve().parent
PATH_KEYS = {'TW_PG_ADMIN_USER', 'TW_CRON_PATHS', 'TW_BACKUP_DIR', 'TW_PG_CONTAINER', 'TW_PG_DB', 'TW_PG_DUMP_USER', 'TW_SMOKE_ATTEMPTS', 'TW_SMOKE_DELAY', 'TW_DB_FILE', 'TW_NETWORK', 'TW_BASH', 'TW_ENV_DIR', 'PATH', 'TW_LOCK_FILE', 'TW_STATE_DIR', 'TW_APP_DIR', 'TW_PYTHON', 'TW_STATE_OWNER_UID',
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
    if operation == 'release' and flags['migrations-aggregate'] != (state.data.get('schema_migrations') or {}).get('aggregate_sha256'):
        raise StateError(72, 'the schema changed since cutover: a schema change needs its own sealed candidate and operator step')
    window = candidate['window']
    if operation == 'stage' and not window['authorized_at'] <= _now() < window['expires_at']:
        raise StateError(73, 'outside the authorised window')
    print(json.dumps({'gate': 'ok', 'op': operation, 'phase': state.phase, 'candidate_sha256': sealed}))


def cmd_phase(paths):
    """Phase for the probe: never fails, so an unreadable marker is reported rather than hidden."""
    try:
        print(State.load(paths['TW_STATE_DIR'], _policy(paths)).phase)
    except StateError:
        print('unreadable')


ATTESTATION_KEYS = ['candidate_sha256', 'digest', 'migrations_aggregate', 'migrations_count', 'phase',
                    'release_commit', 'release_tree', 'script_sha256']


def _read_attestation(text):
    """Strict parse of the report printed by deploy.sh stage; shape problems are exit 64."""
    try:
        report = json.loads(text)
        attestation = report['attestation']
    except (ValueError, KeyError, TypeError):
        raise StateError(64, 'attestation is not valid JSON from deploy.sh stage')
    if type(report) is not dict or sorted(report) != ['attestation', 'stage'] or report['stage'] != 'verified' \
            or type(attestation) is not dict or sorted(attestation) != ATTESTATION_KEYS:
        raise StateError(64, 'attestation has an unexpected shape')
    sha1, sha256 = re.compile(r'\A[0-9a-f]{40}\Z'), HEX64
    if not (re.match(r'\Asha256:[0-9a-f]{64}\Z', str(attestation['digest']))
            and all(type(attestation[k]) is str and sha1.match(attestation[k]) for k in ('release_commit', 'release_tree'))
            and all(type(attestation[k]) is str and sha256.match(attestation[k])
                    for k in ('candidate_sha256', 'migrations_aggregate', 'script_sha256'))
            and _is_int(attestation['migrations_count']) and attestation['migrations_count'] > 0
            and attestation['phase'] == 'prepared'):
        raise StateError(64, 'attestation has invalid values')
    return attestation


def cmd_register_stage(paths):
    """Operator side of stage: re-verify the staged image locally, then record it. deploy.sh never writes state."""
    import subprocess
    attestation = _read_attestation(sys.stdin.read(65536))
    manifest = _manifest()
    state = State.load(paths['TW_STATE_DIR'], _policy(paths))
    if state.phase != 'prepared':
        raise StateError(75, 'phase %s does not accept a staged image' % state.phase)
    candidate = _sealed_candidate(paths, manifest)
    sealed = _sha256((pathlib.Path(paths['TW_STATE_DIR']) / 'candidate.json').read_bytes())
    if sealed != state.candidate_sha256 or attestation['candidate_sha256'] != sealed:
        raise StateError(70, 'attestation is not for the candidate recorded by prepare')
    if attestation['script_sha256'] != candidate['deploy_script_sha256']:
        raise StateError(65, 'attestation was produced by a different deploy.sh')
    if attestation['release_tree'] != candidate['tested_tree']:
        raise StateError(71, 'release tree is not the tested tree')
    migrations = candidate['migrations']
    if attestation['migrations_aggregate'] != migrations['aggregate_sha256'] \
            or attestation['migrations_count'] != migrations['count']:
        raise StateError(72, 'migrations differ from the sealed candidate')
    window = candidate['window']
    now = _now()
    if not window['authorized_at'] <= now < window['expires_at']:
        raise StateError(73, 'outside the authorised window')
    image = 'ghcr.io/dellanio/tech-woman@' + attestation['digest']
    done = subprocess.run([paths['TW_BASH'], (HERE / 'verify-image.sh').as_posix(), image, attestation['release_commit'],
                           attestation['migrations_aggregate'], str(attestation['migrations_count'])],
                          capture_output=True, encoding='utf-8', errors='replace')
    if done.returncode != 0:
        raise StateError(done.returncode, 'operator re-verification failed: ' + done.stderr.strip()[:200])
    state.transition('prepared', now, staged={'digest': attestation['digest'],
                                              'release_commit': attestation['release_commit'],
                                              'release_tree': attestation['release_tree'], 'at': now})
    print(json.dumps({'phase': 'prepared', 'staged': attestation['digest']}))


def _sibling(name):
    sys.path.insert(0, str(HERE))
    try:
        return __import__(name)
    finally:
        sys.path.remove(str(HERE))


def _flags(args, allowed):
    """--name value pairs, only the allowed names, each at most once."""
    if len(args) % 2:
        raise StateError(64, 'flags come in --name value pairs')
    flags = {}
    for i in range(0, len(args), 2):
        name = args[i][2:] if args[i].startswith('--') else None
        if name not in allowed or name in flags:
            raise StateError(64, 'unexpected argument')
        flags[name] = args[i + 1]
    return flags


def _sealed_state(paths, manifest, phase):
    """Marker + candidate that belong together, in the phase an operator command requires."""
    state = State.load(paths['TW_STATE_DIR'], _policy(paths))
    if state.phase != phase:
        raise StateError(75, 'phase %s does not allow this command' % state.phase)
    candidate = _sealed_candidate(paths, manifest)
    if _sha256((pathlib.Path(paths['TW_STATE_DIR']) / 'candidate.json').read_bytes()) != state.candidate_sha256:
        raise StateError(70, 'candidate.json is not the one recorded by prepare')
    return state, candidate


def cmd_freeze(paths, flags):
    quiet = flags.get('quiet-seconds', '5')
    if not (quiet.isdigit() and 1 <= int(quiet) <= 600):
        raise StateError(64, '--quiet-seconds must be 1..600')
    manifest = _manifest()
    state, candidate = _sealed_state(paths, manifest, 'prepared')
    if not state.data.get('staged'):
        raise StateError(75, 'no staged image is registered; run deploy stage and register-stage first')
    window = candidate['window']
    if not window['authorized_at'] <= _now() < window['expires_at']:
        raise StateError(73, 'outside the authorised window')
    freeze = _sibling('freeze')
    inventory_path = pathlib.Path(paths['TW_STATE_DIR']) / 'writers-inventory.json'
    try:
        _check_private_file(inventory_path, _policy(paths))
        inventory_bytes = inventory_path.read_bytes()
        inventory = json.loads(inventory_bytes.decode('utf-8'))
    except (OSError, ValueError, StateError):
        raise StateError(80, 'no readable, root-owned writers inventory for this candidate: nothing was touched')
    try:
        writers = freeze.check_inventory(inventory, state.candidate_sha256)
        record = freeze.freeze(paths, int(quiet), writers)
    except freeze.Refusal as refusal:
        raise StateError(refusal.code, str(refusal))
    now = _now()
    record.update(at=now, cutoff_at=now, inventory_sha256=_sha256(inventory_bytes))
    state.transition('frozen', now, freeze=record)
    print(json.dumps({'phase': 'frozen', 'cutoff_at': now, 'writers_checked': record['writers_checked']}))


def _check_private_file(path, policy):
    """An operator input file: a plain file, owned by the state owner, not writable by group/others."""
    info = policy.lstat(path)
    if not stat.S_ISREG(info.st_mode):
        raise StateError(70, 'not a plain file')
    if policy.owner_uid is not None and info.st_uid != policy.owner_uid:
        raise StateError(70, 'wrong owner')
    if policy.check_mode and info.st_mode & 0o022:
        raise StateError(70, 'writable by others')


def _db_files(paths):
    db = pathlib.Path(paths['TW_DB_FILE'])
    return [p for p in (db, pathlib.Path(str(db) + '-wal'), pathlib.Path(str(db) + '-shm')) if p.exists()]


def cmd_snapshot(paths, flags):
    """Final snapshot after the freeze: Backup API twice (A, then B after the quiet window), A must equal B."""
    import sqlite3, time
    manifest = _manifest()
    state, _ = _sealed_state(paths, manifest, 'frozen')
    snapshot, hostops = _sibling('snapshot'), _sibling('hostops')
    private = pathlib.Path(paths['TW_STATE_DIR']) / 'private'
    private.mkdir(exist_ok=True)
    os.chmod(private, 0o700)
    tag = str(state.seq)
    freeze, runner = _sibling('freeze'), hostops.Runner(paths)
    db = paths['TW_DB_FILE']
    try:
        holders = runner.run(['fuser', '-v', db, db + '-wal', db + '-shm'], ok=(0, 1))
    except hostops.HostError as error:
        raise StateError(83, str(error))
    if holders.returncode == 0:
        raise StateError(80, 'a process holds the database files again since the freeze; nothing was copied')
    if freeze.source_digest(db) != state.data['freeze'].get('db_sha256'):
        raise StateError(80, 'the database changed since the freeze (a writer outside the inventory?); nothing was copied')
    try:
        first = snapshot.backup(paths['TW_DB_FILE'], private / (tag + '-A.db'))
        time.sleep(state.data['freeze']['quiet_seconds'])
        second = snapshot.backup(paths['TW_DB_FILE'], private / (tag + '-B.db'))
    except snapshot.SnapshotError as error:
        raise StateError(error.code, str(error))
    except sqlite3.Error:
        raise StateError(81, 'SQLite refused the snapshot')
    if first['checksum'] != second['checksum'] or first['counts'] != second['counts']:
        raise StateError(81, 'the database changed between snapshot A and B: a writer is still active')
    immutable = True
    for path in _db_files(paths):
        os.chmod(path, os.stat(path).st_mode & ~0o222)
        try:
            runner.run(['chattr', '+i', str(path)])
        except hostops.HostError:
            immutable = False
    now = _now()
    record = {'sha256': first['checksum'], 'a_digest': first['file_sha256'], 'b_digest': second['file_sha256'],
              'counts_public': first['counts'], 'file_a': tag + '-A.db', 'file_b': tag + '-B.db',
              'immutable': immutable, 'at': now}
    private_manifest = private / 'manifest.json'
    private_manifest.write_bytes(_dump({'taken_at': now, 'checksum': first['checksum'], 'files': [
        {'name': record['file_a'], 'bytes': first['bytes'], 'file_sha256': first['file_sha256']},
        {'name': record['file_b'], 'bytes': second['bytes'], 'file_sha256': second['file_sha256']}]}))
    os.chmod(private_manifest, 0o600)
    state.transition('snapshotted', now, snapshot=record)
    print(json.dumps({'phase': 'snapshotted', 'counts': first['counts']}))


def _abort(paths, state, reason, now):
    """Pre-write abort: SQLite service back exactly as it was, files writable again, evidence kept."""
    if (state.phase, 'aborted_pre_write') not in TRANSITIONS:
        raise StateError(75, 'phase %s cannot be aborted' % state.phase)
    hostops, freeze = _sibling('hostops'), _sibling('freeze')
    runner = hostops.Runner(paths)
    original = state.data.get('freeze', {}).get('original_container', freeze.ORIGINAL)
    if original != freeze.ORIGINAL:
        raise StateError(70, 'unexpected original container name in the state')
    for path in _db_files(paths):  # the original application needs its files writable to come back
        try:
            runner.run(['chattr', '-i', str(path)])
        except hostops.HostError:
            pass
        os.chmod(path, os.stat(path).st_mode | 0o200)
    problem = freeze.restore_original(runner, paths, maintenance_up=True)
    if problem:
        freeze.write_protect(runner, paths['TW_DB_FILE'])  # nothing restored: the frozen source stays protected
        raise StateError(84, 'NOT restored: %s. The original container is kept as %s; the pre-write abort is NOT '
                             'recorded; operator action required.' % (problem, freeze.ORIGINAL))
    state.transition('aborted_pre_write', now, abort={'reason': reason, 'at': now})


def cmd_abort(paths, flags):
    reason = flags.get('reason', '')
    if not re.fullmatch(r'[a-z0-9-]{1,40}', reason):
        raise StateError(64, '--reason must be 1..40 characters of [a-z0-9-]')
    state = State.load(paths['TW_STATE_DIR'], _policy(paths))
    _abort(paths, state, reason, _now())
    print(json.dumps({'phase': 'aborted_pre_write', 'reason': reason}))


IMPORT_KEYS = ['counts', 'dryRun', 'idempotent', 'issues', 'runId', 'status']


def _import_report(text):
    lines = [line for line in text.splitlines() if line.strip()]
    try:
        report = json.loads(lines[-1])
    except (IndexError, ValueError):
        raise ValueError('importer printed no JSON report')
    uuid = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    clean = (type(report) is dict and sorted(report) == IMPORT_KEYS and report['dryRun'] is False
             and type(report['idempotent']) is bool and report['status'] == 'imported'
             and _is_int(report['issues']) and report['issues'] == 0 and type(report['counts']) is dict
             and re.fullmatch(uuid, str(report['runId'])) is not None)
    if not clean:
        raise ValueError('importer report is not a clean, complete import')
    return report


def cmd_import_verify(paths, flags):
    """Migrate the target, import the final snapshot, then import it again: the second run must be idempotent
    for the same run id, which proves migration_run.source_checksum equals this snapshot's logical checksum."""
    manifest = _manifest()
    state, _ = _sealed_state(paths, manifest, 'snapshotted')
    hostops = _sibling('hostops')
    runner = hostops.Runner(paths)
    image = 'ghcr.io/dellanio/tech-woman@' + state.data['staged']['digest']
    private = pathlib.Path(paths['TW_STATE_DIR']) / 'private'
    base = ['docker', 'run', '--rm', '--network', paths['TW_NETWORK'], '--env-file',
            str(pathlib.Path(paths['TW_ENV_DIR']) / 'migrator.env'), '--mount',
            'type=bind,src=%s,dst=/snapshot,readonly' % private.as_posix(), '--workdir', '/tools',
            '--memory', '512m', '--cpus', '1', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
            '--entrypoint', 'node', image, '--import', 'tsx']
    target = '/snapshot/' + state.data['snapshot']['file_b']
    now = _now()
    try:
        runner.run(base + ['scripts/migration/migrate.ts'], error='migrations could not be applied')
        first = _import_report(runner.run(base + ['scripts/migration/import.ts', target],
                                          error='importer refused the snapshot').stdout)
        second = _import_report(runner.run(base + ['scripts/migration/import.ts', target],
                                           error='importer refused the repeated snapshot').stdout)
        if first['idempotent'] or not second['idempotent'] or second['runId'] != first['runId']:
            raise ValueError('the repeated import did not recognise the snapshot checksum')
    except (hostops.HostError, ValueError) as error:
        _abort(paths, state, 'import-verification-failed', now)
        raise StateError(82, 'import verification failed: %s' % error)
    state.transition('imported', now, **{'import': {'source_checksum': state.data['snapshot']['sha256'],
                                                    'report_pass': True, 'run_id': first['runId'], 'at': now}})
    print(json.dumps({'phase': 'imported', 'run_id': first['runId']}))


WEB_LIMITS = ['--memory', '384m', '--cpus', '0.5', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3']
SMOKE_SCRIPT = ("fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))")


def _staged_image(state):
    return 'ghcr.io/dellanio/tech-woman@' + state.data['staged']['digest']


def _migrator_argv(paths, image):
    return ['docker', 'run', '--rm', '--network', paths['TW_NETWORK'], '--env-file',
            str(pathlib.Path(paths['TW_ENV_DIR']) / 'migrator.env'), '--workdir', '/tools', '--memory', '512m',
            '--cpus', '1', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '--entrypoint', 'node', image,
            '--import', 'tsx', 'scripts/migration/migrate.ts']


def cmd_activate(paths, flags):
    """imported -> activated: migrator (idempotent), then the web beside the maintenance page. Public stays 503."""
    manifest = _manifest()
    state, candidate = _sealed_state(paths, manifest, 'imported')
    hostops = _sibling('hostops')
    runner = hostops.Runner(paths)
    now = _now()
    window = candidate['window']
    if not window['authorized_at'] <= now < window['expires_at']:
        raise StateError(73, 'outside the authorised window')
    image = _staged_image(state)
    try:
        runner.run(_migrator_argv(paths, image), error='migrations could not be applied')
        runner.run(['docker', 'run', '-d', '--name', 'tech-woman-web-pg', '--restart', 'unless-stopped',
                    '--network', paths['TW_NETWORK'], '--env-file', str(pathlib.Path(paths['TW_ENV_DIR']) / 'web.env'),
                    *WEB_LIMITS, image], error='the web container could not start')
    except hostops.HostError as error:
        _abort(paths, state, 'activation-failed', now)
        raise StateError(77, 'activation failed before any PostgreSQL write: %s' % error)
    state.transition('activated', now, activation={'digest': state.data['staged']['digest'],
                                                   'container': 'tech-woman-web-pg', 'at': now})
    print(json.dumps({'phase': 'activated', 'container': 'tech-woman-web-pg'}))


def cmd_smoke(paths, flags):
    """activated -> smoke_ok with one GET inside the web container; a failure never returns to SQLite."""
    manifest = _manifest()
    state, _ = _sealed_state(paths, manifest, 'activated')
    hostops = _sibling('hostops')
    try:
        hostops.Runner(paths).run(['docker', 'exec', state.data['activation']['container'], 'node', '-e',
                                   SMOKE_SCRIPT], error='internal smoke failed')
    except hostops.HostError as error:
        raise StateError(77, str(error))
    state.transition('smoke_ok', _now())
    print(json.dumps({'phase': 'smoke_ok'}))


BASELINE_SCRIPT = (
    "const {Client}=require('pg');(async()=>{const c=new Client({connectionString:process.env.MIGRATION_DATABASE_URL});"
    "await c.connect();const out={};for(const t of ['participant','enrollment','match','audit_event','app_user'])"
    "{out[t]=Number((await c.query('select count(*) n from public.'+t)).rows[0].n)}"
    "out.audit_max_id=Number((await c.query('select coalesce(max(id),0) n from public.audit_event')).rows[0].n);"
    "console.log(JSON.stringify(out));await c.end()})().catch(()=>process.exit(1))")
BASELINE_KEYS = ['app_user', 'audit_event', 'audit_max_id', 'enrollment', 'match', 'participant']


def _baseline(text):
    try:
        lines = [line for line in text.splitlines() if line.strip()]
        data = json.loads(lines[-1])
    except (IndexError, ValueError):
        raise ValueError('baseline query printed no JSON')
    if type(data) is not dict or sorted(data) != BASELINE_KEYS or not all(_is_int(v) and v >= 0 for v in data.values()):
        raise ValueError('baseline has an unexpected shape')
    return data


def cmd_open_writes(paths, flags):
    """smoke_ok -> pg_write_open: baseline, public traffic to the PG web (same IP/alias), then the mailer."""
    manifest = _manifest()
    state, candidate = _sealed_state(paths, manifest, 'smoke_ok')
    hostops = _sibling('hostops')
    runner = hostops.Runner(paths)
    now = _now()
    window = candidate['window']
    if not window['authorized_at'] <= now < window['expires_at']:
        raise StateError(73, 'outside the authorised window')
    image, network = _staged_image(state), paths['TW_NETWORK']
    env_dir, web = pathlib.Path(paths['TW_ENV_DIR']), state.data['activation']['container']
    base = ['docker', 'run', '--rm', '--network', network, '--env-file', str(env_dir / 'migrator.env'), '--workdir',
            '/tools', '--memory', '256m', '--cpus', '0.5', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3',
            '--entrypoint', 'node', image, '-e', BASELINE_SCRIPT]
    try:
        baseline = _baseline(runner.run(base, error='baseline query failed').stdout)
    except hostops.HostError as error:
        raise StateError(82, str(error))
    except ValueError as error:
        raise StateError(82, str(error))
    ip = state.data['freeze']['ip']
    try:
        runner.run(['docker', 'rm', '-f', 'tech-woman'], error='cannot remove the maintenance container')
        runner.run(['docker', 'network', 'disconnect', network, web], error='cannot detach the PG web')
        runner.run(['docker', 'network', 'connect', '--ip', ip, '--alias', 'app', network, web],
                   error='cannot attach the PG web to the public address')
        runner.run(['docker', 'rename', web, 'tech-woman'], error='cannot rename the PG web')
        runner.run(['docker', 'run', '-d', '--name', 'tech-woman-mailer', '--restart', 'unless-stopped', '--network',
                    network, '--env-file', str(env_dir / 'mailer.env'), '--workdir', '/tools', '--memory', '256m',
                    '--cpus', '0.25', '--log-opt', 'max-size=10m', '--log-opt', 'max-file=3', '--entrypoint', 'node',
                    image, '--import', 'tsx', 'scripts/email-worker.ts'], error='the mailer could not start')
        runner.run(['docker', 'exec', 'tech-woman', 'node', '-e', SMOKE_SCRIPT], error='internal smoke after the switch failed')
    except hostops.HostError as error:
        raise StateError(error.code, 'the switch to PostgreSQL stopped (never back to SQLite): %s' % error)
    digest = state.data['staged']['digest']
    state.transition('pg_write_open', now, known_pg_images=[digest], last_good_pg_image=digest,
                     schema_migrations={'aggregate_sha256': candidate['migrations']['aggregate_sha256']},
                     first_pg_write={'at': None, 'kind': None, 'baseline': baseline})
    print(json.dumps({'phase': 'pg_write_open'}))


def cmd_release_check(paths, flags):
    """Only a previously attested PostgreSQL image may be restarted by a release rollback (exit 76 otherwise)."""
    previous = flags.get('previous-image', '')
    match = re.fullmatch(r'ghcr\.io/dellanio/tech-woman@(sha256:[0-9a-f]{64})', previous)
    state = State.load(paths['TW_STATE_DIR'], _policy(paths))
    if state.phase != 'pg_write_open':
        raise StateError(75, 'release needs phase pg_write_open')
    if not match or match.group(1) not in (state.data.get('known_pg_images') or []):
        raise StateError(76, 'the running web is not a known PostgreSQL image; refusing to touch it')
    last_good = state.data.get('last_good_pg_image')
    if last_good and match.group(1) != last_good:
        # a rollback reuses the running container, so it must be EXACTLY the last good image
        raise StateError(76, 'the running web is a known PostgreSQL image but not the last good one; refusing to touch it')
    print(last_good or 'none')


def cmd_rebind(paths, flags):
    """Operator step for a code-only release: record the newly sealed candidate (same schema, same window rules)."""
    manifest = _manifest()
    state = State.load(paths['TW_STATE_DIR'], _policy(paths))
    if state.phase != 'pg_write_open':
        raise StateError(75, 'rebind needs phase pg_write_open')
    candidate = _sealed_candidate(paths, manifest)
    if candidate['migrations']['aggregate_sha256'] != (state.data.get('schema_migrations') or {}).get('aggregate_sha256'):
        raise StateError(72, 'the candidate changes the schema: that needs its own operator procedure')
    now = _now()
    window = candidate['window']
    if not window['authorized_at'] <= now < window['expires_at']:
        raise StateError(73, 'outside the authorised window')
    digest = _sha256((pathlib.Path(paths['TW_STATE_DIR']) / 'candidate.json').read_bytes())
    state.transition('pg_write_open', now, candidate_sha256=digest)
    print(json.dumps({'phase': 'pg_write_open', 'candidate_sha256': digest}))


RELEASE_ATTESTATION_KEYS = sorted(ATTESTATION_KEYS + ['previous_container', 'backup'])
RELEASE_ATTESTATION_KEYS.remove('phase')


def cmd_register_release(paths, flags):
    """Operator records a released image as known/last good after seeing it run as the public web."""
    try:
        report = json.loads(sys.stdin.read(65536))
        attestation = report['attestation']
    except (ValueError, KeyError, TypeError):
        raise StateError(64, 'attestation is not valid JSON from deploy.sh release')
    if type(report) is not dict or sorted(report) != ['attestation', 'op', 'release'] or report['op'] != 'release'             or report['release'] != 'verified' or type(attestation) is not dict             or sorted(attestation) != RELEASE_ATTESTATION_KEYS             or not re.fullmatch(r'sha256:[0-9a-f]{64}', str(attestation['digest'])):
        raise StateError(64, 'attestation has an unexpected shape')
    manifest = _manifest()
    state, candidate = _sealed_state(paths, manifest, 'pg_write_open')
    sealed = _sha256((pathlib.Path(paths['TW_STATE_DIR']) / 'candidate.json').read_bytes())
    if attestation['candidate_sha256'] != sealed:
        raise StateError(70, 'attestation is not for the recorded candidate')
    if attestation['script_sha256'] != candidate['deploy_script_sha256']:
        raise StateError(65, 'attestation was produced by a different deploy.sh')
    if attestation['release_tree'] != candidate['tested_tree']:
        raise StateError(71, 'release tree is not the tested tree')
    if attestation['migrations_aggregate'] != candidate['migrations']['aggregate_sha256']:
        raise StateError(72, 'migrations differ from the sealed candidate')
    hostops = _sibling('hostops')
    try:
        running = hostops.Runner(paths).run(['docker', 'inspect', 'tech-woman', '--format', '{{.Config.Image}}'],
                                            error='cannot inspect the public web').stdout.strip().split('|')[0]
    except hostops.HostError as error:
        raise StateError(74, str(error))
    if running != 'ghcr.io/dellanio/tech-woman@' + attestation['digest']:
        raise StateError(74, 'the public web is not the attested image')
    known = list(state.data.get('known_pg_images') or [])
    if attestation['digest'] not in known:
        known.append(attestation['digest'])
    state.transition('pg_write_open', _now(), known_pg_images=known, last_good_pg_image=attestation['digest'])
    print(json.dumps({'phase': 'pg_write_open', 'last_good': attestation['digest']}))


def cmd_record_first_write(paths, flags):
    """pg_write_open: record kind and UTC time of the first audited PostgreSQL change above the baseline, once."""
    state = State.load(paths['TW_STATE_DIR'], _policy(paths))
    if state.phase != 'pg_write_open':
        raise StateError(75, 'record-first-write needs phase pg_write_open')
    first = state.data.get('first_pg_write') or {}
    if first.get('kind'):
        raise StateError(75, 'the first PostgreSQL write is already recorded')
    recover = _sibling('recover')
    baseline = first.get('baseline') or {}
    try:
        found = recover.first_write(recover.Pg(paths), baseline)
    except recover.Unreadable as error:
        raise StateError(85, 'the live database is not readable: %s' % error)
    except ValueError as error:
        raise StateError(70, str(error))
    if found is None:
        print(json.dumps({'first_pg_write': None}))
        return
    if not (type(found) is dict and sorted(found) == ['at', 'kind']
            and re.fullmatch(r'[a-z_]{1,40}\.[a-z_]{1,40}', str(found['kind']))
            and re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', str(found['at']))):
        raise StateError(70, 'unexpected first-write description')
    state.transition('pg_write_open', _now(), first_pg_write={'at': found['at'], 'kind': found['kind'],
                                                              'baseline': baseline})
    print(json.dumps({'first_pg_write': found}))


RECOVERY_PHASES = ('pg_write_open', 'recovering')


def _no_proof(paths, candidate, reason):
    """Fail closed: without a readable live database nothing is restored and no success is claimed."""
    backups = pathlib.Path(paths['TW_BACKUP_DIR'])
    try:
        dumps = sorted((p for p in backups.iterdir() if p.is_file() and p.suffix == '.dump'),
                       key=lambda p: p.stat().st_mtime)
        newest = '%s (%s UTC)' % (dumps[-1].name, datetime.datetime.fromtimestamp(
            dumps[-1].stat().st_mtime, datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')) if dumps else 'none found'
    except OSError:
        newest = 'backup directory unreadable'
    return StateError(85, 'live PostgreSQL is not readable (%s): nothing was restored and no success is claimed. '
                          'RPO declared for this cutover: %s. Newest dump on the host: %s. Restoring an older dump '
                          'loses every change after it: an explicit operator decision (decision_ref) is required.'
                      % (reason, candidate['rpo_declared'], newest))


def _recover_restart(paths, state, candidate, now):
    """R-A: PostgreSQL intact after a crash/restart. Prove it by reading it, then bring the known PG web back."""
    recover, hostops = _sibling('recover'), _sibling('hostops')
    baseline = (state.data.get('first_pg_write') or {}).get('baseline') or {}
    try:
        facts = recover.live_facts(recover.Pg(paths), baseline)
    except recover.Unreadable as error:
        raise _no_proof(paths, candidate, str(error))
    except ValueError as error:
        raise StateError(70, str(error))
    lost = [t for t in ('app_user', 'participant', 'enrollment', 'match', 'audit_event')
            if t in baseline and facts['tables'].get(t, -1) < baseline[t]]
    if lost or facts['sequences_behind'] != 0 or \
            ((state.data.get('first_pg_write') or {}).get('kind') and facts['audit_after_baseline'] < 1):
        raise StateError(86, 'the live database does not hold what was committed (tables: %s, sequences behind: %d); '
                             'operator decision required' % (','.join(lost) or '-', facts['sequences_behind']))
    runner = hostops.Runner(paths)
    try:
        running = runner.run(['docker', 'inspect', 'tech-woman', '--format', '{{.Config.Image}}'],
                             error='cannot inspect the public web').stdout.strip().split('|')[0]
    except hostops.HostError as error:
        raise StateError(83, str(error))
    match = re.fullmatch(r'ghcr\.io/dellanio/tech-woman@(sha256:[0-9a-f]{64})', running)
    if not match or match.group(1) not in (state.data.get('known_pg_images') or []):
        raise StateError(76, 'the web container is not a known PostgreSQL image; it is never restarted')
    try:
        runner.run(['docker', 'start', 'tech-woman'], error='cannot start the PostgreSQL web')
        runner.run(['docker', 'start', 'tech-woman-mailer'], error='cannot start the mailer')
        runner.run(['docker', 'exec', 'tech-woman', 'node', '-e', SMOKE_SCRIPT], error='internal smoke failed')
    except hostops.HostError as error:
        raise StateError(77, 'recovery stopped on PostgreSQL (never SQLite): %s' % error)
    return facts


DUMP_NAME = re.compile(r'\A[A-Za-z0-9][A-Za-z0-9._-]{0,122}\.dump\Z')


def _isolated_name(paths, state, now):
    """New database next to the live one, never the live one: <db>_restore_<UTC stamp>_<seq>."""
    name = '%s_restore_%s_%d' % (paths['TW_PG_DB'], re.sub(r'[^0-9]', '', now), state.seq)
    if not re.fullmatch(r'[a-z_][a-z0-9_]{0,62}', name):
        raise StateError(70, 'TW_PG_DB does not allow a safe isolated database name')
    return name


def _restore_and_compare(paths, state, candidate, dump_path, now):
    """Restore a dump into a NEW isolated database and confront it with the live database, row by row."""
    recover = _sibling('recover')
    pg = recover.Pg(paths)
    restored = _isolated_name(paths, state, now)
    try:
        pg.create_database(restored)
        pg.restore(dump_path, restored)
        other = recover.fingerprint(pg, restored)
    except (recover.hostops.HostError, ValueError) as error:
        raise StateError(83, 'the isolated restore failed (live database untouched): %s' % error)
    try:
        live = recover.fingerprint(pg, paths['TW_PG_DB'])
    except (recover.hostops.HostError, ValueError) as error:
        raise _no_proof(paths, candidate, str(error))
    report = recover.compare(live, other)
    report['restored_db'] = restored
    return report


def _recover_compare(paths, state, candidate, flags, now):
    """Inspection: what an existing dump (e.g. the daily one) lacks compared with the live database."""
    name = flags.get('dump', '')
    if not DUMP_NAME.match(name):
        raise StateError(64, '--dump must be the plain name of a .dump file in the backup directory')
    path = pathlib.Path(paths['TW_BACKUP_DIR']) / name
    try:
        if not stat.S_ISREG(os.lstat(path).st_mode):
            raise StateError(64, '--dump is not a plain file')
    except OSError:
        raise StateError(64, 'no such dump in the backup directory')
    recover = _sibling('recover')
    try:
        recover.live_facts(recover.Pg(paths), {})
    except recover.Unreadable as error:
        raise _no_proof(paths, candidate, str(error))
    return _restore_and_compare(paths, state, candidate, path, now)


def _recover_reconcile(paths, state, candidate, now):
    """R-B from an intact database: a complete dump taken NOW, restored in isolation and proven identical (every
    row of every table, every sequence, the schema) before it is accepted as the recovery copy. No partial delta."""
    recover = _sibling('recover')
    backups = pathlib.Path(paths['TW_BACKUP_DIR'])
    dump = backups / ('recovery-%d-%s.dump' % (state.seq, re.sub(r'[^0-9]', '', now)))
    try:
        recover.Pg(paths).dump(dump)
        if dump.stat().st_size == 0:
            raise recover.hostops.HostError(83, 'empty dump')
    except (recover.hostops.HostError, OSError) as error:
        raise _no_proof(paths, candidate, str(error))
    report = _restore_and_compare(paths, state, candidate, dump, now)
    report['dump'] = dump.name
    report['dump_sha256'] = _sha256(dump.read_bytes())
    return report


def cmd_recover(paths, flags):
    """Post-write recovery. Never touches SQLite; deploys stay denied (phase recovering) until it succeeds."""
    mode = flags.get('mode')
    if mode not in ('restart', 'compare', 'reconcile') or (mode != 'compare' and 'dump' in flags):
        raise StateError(64, '--mode must be restart, reconcile or compare --dump <name>')
    manifest = _manifest()
    state = State.load(paths['TW_STATE_DIR'], _policy(paths))
    if state.phase not in RECOVERY_PHASES:
        raise StateError(75, 'recover needs phase pg_write_open or recovering')
    candidate = _sealed_candidate(paths, manifest)
    now = _now()
    if mode == 'compare':
        report = _recover_compare(paths, state, candidate, flags, now)
        print(json.dumps(dict(report, mode=mode, phase=state.phase)))
        if not report['equal']:
            raise StateError(86, 'the dump differs from the live database (see the report)')
        return
    if state.phase == 'pg_write_open':
        state.transition('recovering', now, recovery={'mode': mode, 'started_at': now, 'result': 'in-progress'})
    if mode == 'restart':
        facts = _recover_restart(paths, state, candidate, now)
        state.transition('pg_write_open', _now(), recovery={'mode': mode, 'started_at': now, 'result': 'ok',
                                                            'live': facts})
        print(json.dumps({'mode': mode, 'phase': 'pg_write_open', 'live': facts}))
        return
    report = _recover_reconcile(paths, state, candidate, now)
    if not report['equal']:
        print(json.dumps(dict(report, mode=mode, phase='recovering')))
        raise StateError(86, 'the restored copy is not identical to the live database: a writer is active or the '
                             'restore is incomplete; nothing is accepted')
    state.transition('pg_write_open', _now(), recovery={
        'mode': mode, 'started_at': now, 'result': 'ok', 'restored_db': report['restored_db'], 'dump': report['dump'],
        'dump_sha256': report['dump_sha256'], 'tables': report['tables'], 'rows': report['rows']})
    print(json.dumps(dict(report, mode=mode, phase='pg_write_open')))


COMMANDS = {
    'prepare': lambda paths, flags: cmd_prepare(paths),
    'status': lambda paths, flags: cmd_status(paths),
    'phase': lambda paths, flags: cmd_phase(paths),
    'register-stage': lambda paths, flags: cmd_register_stage(paths),
    'freeze': cmd_freeze,
    'snapshot': lambda paths, flags: cmd_snapshot(paths, flags),
    'import-verify': cmd_import_verify,
    'abort': cmd_abort,
    'activate': cmd_activate,
    'smoke': cmd_smoke,
    'open-writes': cmd_open_writes,
    'release-check': cmd_release_check,
    'rebind': cmd_rebind,
    'register-release': cmd_register_release,
    'record-first-write': cmd_record_first_write,
    'recover': cmd_recover,
}
FLAG_NAMES = {'freeze': ['quiet-seconds'], 'abort': ['reason'], 'release-check': ['previous-image'],
              'recover': ['mode', 'dump']}


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
        if len(argv) < 2 or argv[1] not in COMMANDS:
            print('usage: cutover.py {%s|gate}' % '|'.join(sorted(COMMANDS)), file=sys.stderr)
            return 64
        flags = _flags(argv[2:], FLAG_NAMES.get(argv[1], []))
        COMMANDS[argv[1]](read_paths(), flags)
        return 0
    except StateError as error:
        print('cutover: %s' % error, file=sys.stderr)
        return error.code


if __name__ == '__main__':
    sys.exit(main(sys.argv))
