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


if __name__ == '__main__':
    unittest.main()
