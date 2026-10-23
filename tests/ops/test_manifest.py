import hashlib, json, pathlib, subprocess, sys, tempfile, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
MANIFEST = ROOT / 'ops/manifest.py'

NODE_SHA = (r"const {createHash}=require('node:crypto');const {readFileSync}=require('node:fs');"
            r"const s=readFileSync(process.argv[1],'utf8');"
            r"process.stdout.write(createHash('sha256').update(s.replace(/\r\n/g,'\n')).digest('hex'))")


def manifest(*args, stdin=None, cwd=None):
    done = subprocess.run([sys.executable, '-I', str(MANIFEST), *map(str, args)], input=stdin, text=True,
                          capture_output=True, cwd=cwd)
    return done


def write(path, data):
    path.write_bytes(data)
    return path


class MigrationHashTests(unittest.TestCase):
    def test_crlf_and_lf_hash_identically_and_match_migrate_ts_algorithm(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            crlf = tmp / 'crlf'; lf = tmp / 'lf'
            crlf.mkdir(); lf.mkdir()
            write(crlf / '20260101000000_a.sql', b'select 1;\r\nselect 2;\r\n')
            write(lf / '20260101000000_a.sql', b'select 1;\nselect 2;\n')
            out_crlf = manifest('migrations', crlf)
            out_lf = manifest('migrations', lf)
            self.assertEqual(out_crlf.returncode, 0, out_crlf.stderr)
            self.assertEqual(json.loads(out_crlf.stdout), json.loads(out_lf.stdout))
            node = subprocess.run(['node', '-e', NODE_SHA, str(crlf / '20260101000000_a.sql')],
                                  capture_output=True, text=True, check=True).stdout
            self.assertEqual(json.loads(out_crlf.stdout)['files'][0]['sha256'], node)


    def test_aggregate_is_sha_of_sorted_name_colon_hash_lines(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            write(tmp / '20260102000000_b.sql', b'select 2;\n')
            write(tmp / '20260101000000_a.sql', b'select 1;\n')
            write(tmp / 'notes.txt', b'ignored')
            out = json.loads(manifest('migrations', tmp).stdout)
        self.assertEqual([f['name'] for f in out['files']], ['20260101000000_a.sql', '20260102000000_b.sql'])
        self.assertEqual(out['count'], 2)
        lines = ''.join('%s:%s\n' % (f['name'], f['sha256']) for f in out['files'])
        self.assertEqual(out['aggregate_sha256'], hashlib.sha256(lines.encode()).hexdigest())


class OpsPackageTests(unittest.TestCase):
    def make_ops(self, tmp):
        ops = tmp / 'ops'
        (ops / '__pycache__').mkdir(parents=True)
        write(ops / 'deploy.sh', b'#!/usr/bin/env bash\necho deploy\n')
        write(ops / 'manifest.py', b'print(1)\n')
        write(ops / 'verify-image.sh', b'#!/usr/bin/env bash\necho verify\n')
        write(ops / '__pycache__' / 'manifest.cpython-312.pyc', b'\x00junk')
        return ops

    def test_script_sha_is_sha256_of_exact_bytes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = write(pathlib.Path(tmp) / 'deploy.sh', b'#!/usr/bin/env bash\necho hi\n')
            out = manifest('script-sha', path)
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(json.loads(out.stdout), {'sha256': hashlib.sha256(b'#!/usr/bin/env bash\necho hi\n').hexdigest()})

    def test_ops_package_hash_covers_every_helper_and_ignores_caches(self):
        with tempfile.TemporaryDirectory() as tmp:
            ops = self.make_ops(pathlib.Path(tmp))
            first = json.loads(manifest('ops-package', ops).stdout)
            write(ops / '__pycache__' / 'manifest.cpython-312.pyc', b'\x00other')
            self.assertEqual(json.loads(manifest('ops-package', ops).stdout), first)
            self.assertEqual([f['name'] for f in first['files']], ['deploy.sh', 'manifest.py', 'verify-image.sh'])
            lines = ''.join('%s:%s\n' % (f['name'], f['sha256']) for f in first['files'])
            self.assertEqual(first['aggregate_sha256'], hashlib.sha256(lines.encode()).hexdigest())
            write(ops / 'manifest.py', b'print(2)\n')
            changed = json.loads(manifest('ops-package', ops).stdout)
        self.assertNotEqual(changed['aggregate_sha256'], first['aggregate_sha256'])


if __name__ == '__main__':
    unittest.main()
