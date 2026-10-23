#!/usr/bin/env python3
"""Candidate identity: migration hashes, release tree checks, sealed candidate.json. Stdlib only."""
import hashlib, json, pathlib, sys


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
            files.append({'name': rel, 'sha256': _sha256(path.read_bytes())})
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


def seal(facts, migrations_dir, ops_dir):
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


def _flags(args, names):
    values = {}
    for i in range(0, len(args), 2):
        values[args[i][2:]] = args[i + 1]
    if sorted(values) != sorted(names):
        raise SystemExit(64)
    return values


def main(argv):
    cmd, args = (argv[1] if len(argv) > 1 else ''), argv[2:]
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
    print('usage: manifest.py {migrations <dir>|script-sha <file>|ops-package <dir>|seal --facts F ...}', file=sys.stderr)
    return 64


if __name__ == '__main__':
    sys.exit(main(sys.argv))
