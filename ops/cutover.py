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

    def transition(self, target, now, **updates):
        if (self.phase, target) not in TRANSITIONS:
            raise StateError(75, 'transition %s -> %s is not allowed' % (self.phase, target))
        data = dict(self.data, seq=self.seq + 1, prev_sha256=self._last_entry_sha(), phase=target, **updates)
        self._commit(data, self.phase, now)


HERE = pathlib.Path(__file__).resolve().parent
PATH_KEYS = {'TW_DB_FILE', 'TW_NETWORK', 'TW_BASH', 'TW_ENV_DIR', 'PATH', 'TW_LOCK_FILE', 'TW_STATE_DIR', 'TW_APP_DIR', 'TW_PYTHON', 'TW_STATE_OWNER_UID',
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
    try:
        record = freeze.freeze(paths, int(quiet))
    except freeze.Refusal as refusal:
        raise StateError(refusal.code, str(refusal))
    now = _now()
    record.update(at=now, cutoff_at=now)
    state.transition('frozen', now, freeze=record)
    print(json.dumps({'phase': 'frozen', 'cutoff_at': now, 'writers_checked': record['writers_checked']}))


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
    runner, immutable = hostops.Runner(paths), True
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
    for path in _db_files(paths):
        try:
            runner.run(['chattr', '-i', str(path)])
        except hostops.HostError:
            pass
        os.chmod(path, os.stat(path).st_mode | 0o200)
    try:
        runner.run(['docker', 'rm', '-f', freeze.CONTAINER])
        runner.run(['docker', 'rename', original, freeze.CONTAINER])
        runner.run(['docker', 'start', freeze.CONTAINER])
    except hostops.HostError as error:
        raise StateError(83, 'could not restore the original service: %s' % error)
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


COMMANDS = {
    'prepare': lambda paths, flags: cmd_prepare(paths),
    'status': lambda paths, flags: cmd_status(paths),
    'phase': lambda paths, flags: cmd_phase(paths),
    'register-stage': lambda paths, flags: cmd_register_stage(paths),
    'freeze': cmd_freeze,
    'snapshot': lambda paths, flags: cmd_snapshot(paths, flags),
    'import-verify': cmd_import_verify,
    'abort': cmd_abort,
}
FLAG_NAMES = {'freeze': ['quiet-seconds'], 'abort': ['reason']}


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
