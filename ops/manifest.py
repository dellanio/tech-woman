#!/usr/bin/env python3
"""Candidate identity: migration hashes, release tree checks, sealed candidate.json. Stdlib only."""
import datetime, hashlib, json, pathlib, re, sys

HEX40 = re.compile(r'\A[0-9a-f]{40}\Z')
HEX64 = re.compile(r'\A[0-9a-f]{64}\Z')
RFC3339Z = re.compile(r'\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\Z')
GATES = ('GATE-001', 'GATE-002', 'GATE-003')


class ManifestError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def _aggregate(files):
    return _sha256(''.join('%s:%s\n' % (f['name'], f['sha256']) for f in files).encode())


def migrations(directory):
    """Hash each *.sql like scripts/migration/migrate.ts: sha256 of content with CRLF folded to LF."""
    files = []
    for path in sorted(pathlib.Path(directory).glob('*.sql'), key=lambda p: p.name):
        files.append({'name': path.name, 'sha256': _sha256(path.read_bytes().replace(b'\r\n', b'\n'))})
    return {'count': len(files), 'aggregate_sha256': _aggregate(files), 'files': files}


def script_sha(path):
    return {'sha256': _sha256(pathlib.Path(path).read_bytes())}


def ops_package(directory):
    """Hash every installed ops file (shell and Python helpers), exact bytes, no caches."""
    root = pathlib.Path(directory)
    files = []
    for path in sorted(root.rglob('*'), key=lambda p: p.relative_to(root).as_posix()):
        rel = path.relative_to(root).as_posix()
        if path.is_file() and '__pycache__' not in path.parts and not rel.endswith('.pyc'):
            data = path.read_bytes()
            if b'\r' in data:
                raise ManifestError(65, '%s has CR bytes; ops files must be real LF' % rel)
            files.append({'name': rel, 'sha256': _sha256(data)})
    return {'files': files, 'aggregate_sha256': _aggregate(files)}


IMAGE = {
    'platform': 'linux/arm64',
    'repository': 'ghcr.io/dellanio/tech-woman',
    'entrypoints': {
        'web': ['node', 'server.js'],
        'mailer': ['node', '--import', 'tsx', 'scripts/email-worker.ts'],
        'migrator': ['node', '--import', 'tsx', 'scripts/migration/migrate.ts'],
    },
}


def _is_hex(value, pattern):
    return type(value) is str and pattern.match(value) is not None


def _is_text(value, limit=200):
    return type(value) is str and 0 < len(value) <= limit


def _closed(obj, keys, code, where):
    if type(obj) is not dict or sorted(obj) != sorted(keys):
        raise ManifestError(code, '%s: unexpected shape' % where)


def _moment(value):
    if not _is_hex(value, RFC3339Z):
        raise ValueError(value)
    return datetime.datetime.strptime(value, '%Y-%m-%dT%H:%M:%SZ')


def validate_facts(facts):
    _closed(facts, ['tested_head', 'tested_tree', 'base_main', 'ci', 'gates', 'window',
                    'recovery_evidence_sha256', 'rpo_declared'], 70, 'facts')
    for key in ('tested_head', 'tested_tree', 'base_main'):
        if not _is_hex(facts[key], HEX40):
            raise ManifestError(70, '%s must be a 40-hex object id' % key)
    ci = facts['ci']
    _closed(ci, ['run_id', 'conclusion', 'head_sha', 'tree'], 70, 'ci')
    if not (_is_text(ci['run_id'], 40) and ci['conclusion'] == 'success'
            and ci['head_sha'] == facts['tested_head'] and ci['tree'] == facts['tested_tree']):
        raise ManifestError(71, 'CI proof does not cover the tested head and tree')
    gates = facts['gates']
    if type(gates) is not dict or set(gates) - set(GATES):
        raise ManifestError(70, 'gates: unexpected shape')
    if any(gates.get(g) != 'green' for g in GATES):
        raise ManifestError(71, 'a required gate is not green')
    window = facts['window']
    _closed(window, ['decision_ref', 'authorized_at', 'expires_at', 'measured_seconds'], 73, 'window')
    try:
        ok = (_is_text(window['decision_ref'], 80) and type(window['measured_seconds']) is int
              and window['measured_seconds'] > 0
              and _moment(window['authorized_at']) < _moment(window['expires_at']))
    except ValueError:
        ok = False
    if not ok:
        raise ManifestError(73, 'window is missing, unmeasured or not ordered')
    if not _is_hex(facts['recovery_evidence_sha256'], HEX64) or not _is_text(facts['rpo_declared']):
        raise ManifestError(78, 'recovery evidence and declared RPO are required')


def seal(facts, migrations_dir, ops_dir):
    validate_facts(facts)
    package = ops_package(ops_dir)
    deploy = [f for f in package['files'] if f['name'] == 'deploy.sh'][0]
    return {
        'schema': 1,
        'tested_head': facts['tested_head'],
        'tested_tree': facts['tested_tree'],
        'base_main': facts['base_main'],
        'migrations': migrations(migrations_dir),
        'ops_package': package,
        'deploy_script_sha256': deploy['sha256'],
        'image': IMAGE,
        'ci': facts['ci'],
        'gates': facts['gates'],
        'window': facts['window'],
        'recovery_evidence_sha256': facts['recovery_evidence_sha256'],
        'rpo_declared': facts['rpo_declared'],
    }


def load_candidate(path):
    """Parse a sealed candidate.json strictly; anything unexpected is exit 70."""
    try:
        candidate = json.loads(pathlib.Path(path).read_text(encoding='utf-8'))
    except (OSError, ValueError):
        raise ManifestError(70, 'candidate.json missing or unreadable')
    _closed(candidate, ['schema', 'tested_head', 'tested_tree', 'base_main', 'migrations', 'ops_package',
                        'deploy_script_sha256', 'image', 'ci', 'gates', 'window', 'recovery_evidence_sha256',
                        'rpo_declared'], 70, 'candidate')
    if type(candidate['schema']) is not int or candidate['schema'] != 1 or candidate['image'] != IMAGE:
        raise ManifestError(70, 'candidate schema or image not recognised')
    try:
        validate_facts({k: candidate[k] for k in ('tested_head', 'tested_tree', 'base_main', 'ci', 'gates',
                                                  'window', 'recovery_evidence_sha256', 'rpo_declared')})
    except ManifestError as error:
        raise ManifestError(70, 'candidate facts invalid: %s' % error)
    for key, extra in (('migrations', ['count']), ('ops_package', [])):
        section = candidate[key]
        _closed(section, ['files', 'aggregate_sha256'] + extra, 70, key)
        files = section['files']
        if not (type(files) is list and all(type(f) is dict and sorted(f) == ['name', 'sha256']
                                            and _is_text(f['name'], 200) and _is_hex(f['sha256'], HEX64)
                                            for f in files)):
            raise ManifestError(70, '%s.files malformed' % key)
        if section['aggregate_sha256'] != _aggregate(files):
            raise ManifestError(70, '%s aggregate does not match its files' % key)
    count = candidate['migrations']['count']
    if type(count) is not int or count != len(candidate['migrations']['files']):
        raise ManifestError(70, 'migrations.count mismatch')
    deploy = [f['sha256'] for f in candidate['ops_package']['files'] if f['name'] == 'deploy.sh']
    if deploy != [candidate['deploy_script_sha256']]:
        raise ManifestError(70, 'deploy_script_sha256 not part of the ops package')
    return candidate


def verify_release(flags):
    """Deny (before any effect) anything that is not exactly the sealed candidate."""
    if not (_is_hex(flags['release-tree'], HEX40) and _is_hex(flags['release-commit'], HEX40)
            and _is_hex(flags['digest'], re.compile(r'\Asha256:[0-9a-f]{64}\Z')) and _is_hex(flags['now'], RFC3339Z)):
        raise ManifestError(64, 'invalid release identity')
    candidate = load_candidate(flags['candidate'])
    if ops_package(flags['ops-dir'])['files'] != candidate['ops_package']['files']:
        raise ManifestError(65, 'installed ops package differs from the sealed candidate')
    if flags['release-tree'] != candidate['tested_tree']:
        raise ManifestError(71, 'release tree is not the tested tree')
    if migrations(flags['migrations-dir'])['files'] != candidate['migrations']['files']:
        raise ManifestError(72, 'migrations differ from the sealed candidate')
    window = candidate['window']
    if not _moment(window['authorized_at']) <= _moment(flags['now']) < _moment(window['expires_at']):
        raise ManifestError(73, 'outside the authorised window')
    return {'ok': True, 'release_commit_is_tested_head': flags['release-commit'] == candidate['tested_head']}


def _flags(args, names):
    values = {}
    for i in range(0, len(args), 2):
        values[args[i][2:]] = args[i + 1]
    if sorted(values) != sorted(names):
        raise SystemExit(64)
    return values


def main(argv):
    try:
        return _run(argv[1] if len(argv) > 1 else '', argv[2:])
    except ManifestError as error:
        print('manifest: %s' % error, file=sys.stderr)
        return error.code


def _run(cmd, args):
    if cmd == 'migrations' and len(args) == 1:
        print(json.dumps(migrations(args[0])))
        return 0
    if cmd == 'script-sha' and len(args) == 1:
        print(json.dumps(script_sha(args[0])))
        return 0
    if cmd == 'ops-package' and len(args) == 1:
        print(json.dumps(ops_package(args[0])))
        return 0
    if cmd == 'seal':
        flags = _flags(args, ['facts', 'migrations-dir', 'ops-dir', 'out'])
        facts = json.loads(pathlib.Path(flags['facts']).read_text())
        data = (json.dumps(seal(facts, flags['migrations-dir'], flags['ops-dir']), indent=2, sort_keys=True) + '\n').encode()
        pathlib.Path(flags['out']).write_bytes(data)
        print(json.dumps({'candidate_sha256': _sha256(data)}))
        return 0
    if cmd == 'verify-release':
        flags = _flags(args, ['candidate', 'release-tree', 'release-commit', 'digest', 'now',
                              'migrations-dir', 'ops-dir'])
        print(json.dumps(verify_release(flags)))
        return 0
    print('usage: manifest.py {migrations <dir>|script-sha <file>|ops-package <dir>|seal --facts F ...}', file=sys.stderr)
    return 64


if __name__ == '__main__':
    sys.exit(main(sys.argv))
