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


def main(argv):
    if len(argv) == 3 and argv[1] == 'migrations':
        print(json.dumps(migrations(argv[2])))
        return 0
    if len(argv) == 3 and argv[1] == 'script-sha':
        print(json.dumps(script_sha(argv[2])))
        return 0
    if len(argv) == 3 and argv[1] == 'ops-package':
        print(json.dumps(ops_package(argv[2])))
        return 0
    print('usage: manifest.py {migrations <dir>|script-sha <file>|ops-package <dir>}', file=sys.stderr)
    return 64


if __name__ == '__main__':
    sys.exit(main(sys.argv))
