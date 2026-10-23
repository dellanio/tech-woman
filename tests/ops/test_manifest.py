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

    def test_ops_package_and_seal_refuse_crlf_files_instead_of_normalizing_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            ops = self.make_ops(tmp)
            write(ops / 'manifest.py', b'print(1)\r\n')
            done = manifest('ops-package', ops)
            self.assertEqual(done.returncode, 65, done.stderr)
            self.assertEqual(done.stdout, '')
            (tmp / 'drizzle').mkdir()
            facts = write(tmp / 'facts.json', json.dumps(good_facts()).encode())
            sealed = manifest('seal', '--facts', facts, '--migrations-dir', tmp / 'drizzle', '--ops-dir', ops,
                              '--out', tmp / 'candidate.json')
            self.assertEqual(sealed.returncode, 65, sealed.stderr)
            self.assertFalse((tmp / 'candidate.json').exists())


HEAD, TREE, MAIN = 'a' * 40, 'b' * 40, 'c' * 40


def good_facts():
    return {
        'tested_head': HEAD, 'tested_tree': TREE, 'base_main': MAIN,
        'ci': {'run_id': '123', 'conclusion': 'success', 'head_sha': HEAD, 'tree': TREE},
        'gates': {'GATE-001': 'green', 'GATE-002': 'green', 'GATE-003': 'green'},
        'window': {'decision_ref': 'dec-1', 'authorized_at': '2026-10-23T12:00:00Z',
                   'expires_at': '2026-10-23T14:00:00Z', 'measured_seconds': 900},
        'recovery_evidence_sha256': 'd' * 64,
        'rpo_declared': 'ate 24h (dump diario)',
    }


class SealTests(unittest.TestCase):
    def seal(self, tmp, facts):
        ops = OpsPackageTests().make_ops(tmp)
        mig = tmp / 'drizzle'
        mig.mkdir()
        write(mig / '20260101000000_a.sql', b'select 1;\n')
        facts_path = write(tmp / 'facts.json', json.dumps(facts).encode())
        out = tmp / 'candidate.json'
        done = manifest('seal', '--facts', facts_path, '--migrations-dir', mig, '--ops-dir', ops, '--out', out)
        return done, out, mig, ops

    def test_seal_writes_closed_candidate_bound_to_tree_migrations_and_ops_package(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            done, out, mig, ops = self.seal(tmp, good_facts())
            self.assertEqual(done.returncode, 0, done.stderr)
            candidate = json.loads(out.read_text())
            self.assertEqual(json.loads(done.stdout), {'candidate_sha256': hashlib.sha256(out.read_bytes()).hexdigest()})
            self.assertEqual(candidate['migrations'], json.loads(manifest('migrations', mig).stdout))
            package = json.loads(manifest('ops-package', ops).stdout)
            self.assertEqual(candidate['ops_package'], package)
            self.assertEqual(candidate['deploy_script_sha256'],
                             [f for f in package['files'] if f['name'] == 'deploy.sh'][0]['sha256'])
        self.assertEqual(sorted(candidate), sorted([
            'schema', 'tested_head', 'tested_tree', 'base_main', 'migrations', 'ops_package',
            'deploy_script_sha256', 'image', 'ci', 'gates', 'window', 'recovery_evidence_sha256', 'rpo_declared']))
        self.assertEqual((candidate['schema'], candidate['tested_head'], candidate['tested_tree'], candidate['base_main']),
                         (1, HEAD, TREE, MAIN))
        self.assertEqual(candidate['image']['platform'], 'linux/arm64')
        self.assertEqual(candidate['image']['repository'], 'ghcr.io/dellanio/tech-woman')
        self.assertEqual(sorted(candidate['image']['entrypoints']), ['mailer', 'migrator', 'web'])

    def test_seal_refuses_unproven_candidate_with_stable_exit_code_and_writes_nothing(self):
        def drop(d, *path):
            for key in path[:-1]:
                d = d[key]
            del d[path[-1]]

        def put(d, value, *path):
            for key in path[:-1]:
                d = d[key]
            d[path[-1]] = value

        cases = {
            'ci not success': (71, lambda f: put(f, 'failure', 'ci', 'conclusion')),
            'ci other head': (71, lambda f: put(f, 'e' * 40, 'ci', 'head_sha')),
            'ci other tree': (71, lambda f: put(f, 'e' * 40, 'ci', 'tree')),
            'gate red': (71, lambda f: put(f, 'red', 'gates', 'GATE-002')),
            'gate missing': (71, lambda f: drop(f, 'gates', 'GATE-003')),
            'measured zero': (73, lambda f: put(f, 0, 'window', 'measured_seconds')),
            'measured bool': (73, lambda f: put(f, True, 'window', 'measured_seconds')),
            'window not ordered': (73, lambda f: put(f, '2026-10-23T11:00:00Z', 'window', 'expires_at')),
            'window no decision': (73, lambda f: put(f, '', 'window', 'decision_ref')),
            'window bad date': (73, lambda f: put(f, '2026-10-23 12:00', 'window', 'authorized_at')),
            'recovery evidence short': (78, lambda f: put(f, 'abc', 'recovery_evidence_sha256')),
            'rpo empty': (78, lambda f: put(f, '', 'rpo_declared')),
            'unknown fact': (70, lambda f: put(f, 1, 'surprise')),
            'head not sha': (70, lambda f: put(f, 'HEAD', 'tested_head')),
            'tree not sha': (70, lambda f: put(f, 'z' * 40, 'tested_tree')),
        }
        for name, (code, mutate) in cases.items():
            with self.subTest(name=name), tempfile.TemporaryDirectory() as tmp:
                facts = good_facts()
                mutate(facts)
                done, out, _, _ = self.seal(pathlib.Path(tmp), facts)
                self.assertEqual(done.returncode, code, done.stderr)
                self.assertFalse(out.exists())


DIGEST = 'sha256:' + '1' * 64
NOW = '2026-10-23T12:30:00Z'


class VerifyReleaseTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = pathlib.Path(self._tmp.name)
        done, self.candidate, self.mig, self.ops = SealTests().seal(self.tmp, good_facts())
        self.assertEqual(done.returncode, 0, done.stderr)

    def verify(self, tree=TREE, commit=HEAD, digest=DIGEST, now=NOW, candidate=None, mig=None, ops=None):
        return manifest('verify-release', '--candidate', candidate or self.candidate, '--release-tree', tree,
                        '--release-commit', commit, '--digest', digest, '--now', now,
                        '--migrations-dir', mig or self.mig, '--ops-dir', ops or self.ops)

    def test_accepts_the_tested_tree_and_a_squash_commit_with_the_same_tree(self):
        same = self.verify()
        self.assertEqual(same.returncode, 0, same.stderr)
        self.assertEqual(json.loads(same.stdout), {'ok': True, 'release_commit_is_tested_head': True})
        squash = self.verify(commit='f' * 40)
        self.assertEqual(squash.returncode, 0, squash.stderr)
        self.assertEqual(json.loads(squash.stdout), {'ok': True, 'release_commit_is_tested_head': False})


if __name__ == '__main__':
    unittest.main()
