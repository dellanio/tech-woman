#!/usr/bin/env python3
"""Candidate identity: migration hashes, release tree checks, sealed candidate.json. Stdlib only."""
import hashlib, json, pathlib, sys


def _sha256(data):
    return hashlib.sha256(data).hexdigest()


def migrations(directory):
    """Hash each *.sql like scripts/migration/migrate.ts: sha256 of content with CRLF folded to LF."""
    files = []
    for path in sorted(pathlib.Path(directory).glob('*.sql'), key=lambda p: p.name):
        files.append({'name': path.name, 'sha256': _sha256(path.read_bytes().replace(b'\r\n', b'\n'))})
    return {'count': len(files), 'files': files}


def main(argv):
    if len(argv) == 3 and argv[1] == 'migrations':
        print(json.dumps(migrations(argv[2])))
        return 0
    print('usage: manifest.py migrations <dir>', file=sys.stderr)
    return 64


if __name__ == '__main__':
    sys.exit(main(sys.argv))
