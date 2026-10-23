import hashlib, json, pathlib, shutil, subprocess, sys, tempfile, unittest

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


def make_tar(entries):
    """entries: list of (name, bytes|None, kind) -> tar stream bytes (kind: 'file', 'dir', 'symlink')."""
    import io, tarfile
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w') as archive:
        for name, data, kind in entries:
            info = tarfile.TarInfo(name)
            if kind == 'dir':
                info.type = tarfile.DIRTYPE
                archive.addfile(info)
            elif kind == 'symlink':
                info.type = tarfile.SYMTYPE
                info.linkname = '/etc/passwd'
                archive.addfile(info)
            else:
                info.size = len(data)
                archive.addfile(info, io.BytesIO(data))
    return buffer.getvalue()


def manifest_bytes(*args, stdin=b''):
    return subprocess.run([sys.executable, '-I', str(MANIFEST), *map(str, args)], input=stdin, capture_output=True)


class MigrationsFromTarTests(unittest.TestCase):
    def test_tar_stream_hashes_exactly_like_the_directory(self):
        archive = make_tar([('./', None, 'dir'), ('./20260101000000_a.sql', b'select 1;\r\nselect 2;\r\n', 'file'),
                            ('./20260102000000_b.sql', b'select 3;\n', 'file'), ('./meta/_journal.json', b'{}', 'file')])
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            write(tmp / '20260101000000_a.sql', b'select 1;\r\nselect 2;\r\n')
            write(tmp / '20260102000000_b.sql', b'select 3;\n')
            expected = json.loads(manifest('migrations', tmp).stdout)
        done = manifest_bytes('migrations-tar', stdin=archive)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout), expected)

    def test_hostile_tar_entries_are_refused_with_74(self):
        sql = b'select 1;\n'
        cases = {
            'symlink named like a migration': [('20260101000000_a.sql', None, 'symlink')],
            'path traversal': [('../20260101000000_a.sql', sql, 'file')],
            'absolute path': [('/20260101000000_a.sql', sql, 'file')],
            'nested migration': [('sub/20260101000000_a.sql', sql, 'file')],
            'oversized migration': [('20260101000000_a.sql', b'x' * (1024 * 1024 + 1), 'file')],
            'not a tar': None,
        }
        for name, entries in cases.items():
            with self.subTest(name=name):
                archive = b'this is not a tar archive' * 40 if entries is None else make_tar(entries)
                done = manifest_bytes('migrations-tar', stdin=archive)
                self.assertEqual(done.returncode, 74, done.stderr)
                self.assertEqual(done.stdout, b'')


class OpsPackageTests(unittest.TestCase):
    def make_ops(self, tmp):
        ops = tmp / 'ops'
        (ops / '__pycache__').mkdir(parents=True, exist_ok=True)
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

    def test_ops_package_sha_prints_only_the_aggregate_and_refuses_cr(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = pathlib.Path(tmp)
            ops = self.make_ops(tmp)
            aggregate = json.loads(manifest('ops-package', ops).stdout)['aggregate_sha256']
            done = manifest('ops-package-sha', ops)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(done.stdout.strip(), aggregate)
            write(ops / 'manifest.py', b'print(1)' + bytes([13, 10]))
            self.assertEqual(manifest('ops-package-sha', ops).returncode, 65)

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

    def test_denies_divergent_release_with_stable_codes(self):
        def tree(v):
            return {'tree': v}

        def edit(name, data):
            return lambda mig, ops: write(ops / name, data)

        def drop_ops(name):
            return lambda mig, ops: (ops / name).unlink()

        def extra_migration(mig, ops):
            write(mig / '20260105000000_extra.sql', b'select 9;\n')

        def drop_migration(mig, ops):
            (mig / '20260101000000_a.sql').unlink()

        def alter_migration(mig, ops):
            write(mig / '20260101000000_a.sql', b'select 1; -- changed\n')

        def rename_migration(mig, ops):
            (mig / '20260101000000_a.sql').rename(mig / '20250101000000_a.sql')

        cases = [
            ('main advanced, different tree', 71, tree('9' * 40), None),
            ('digest latest', 64, {'digest': 'latest'}, None),
            ('digest short', 64, {'digest': 'sha256:abc'}, None),
            ('digest protocol token', 64, {'digest': 'TWDEPLOY/2'}, None),
            ('tree is not an object id', 64, tree('HEAD;rm -rf /'), None),
            ('deploy.sh differs', 65, {}, edit('deploy.sh', b'#!/usr/bin/env bash\necho other\n')),
            ('helper differs', 65, {}, edit('manifest.py', b'print(3)\n')),
            ('extra helper', 65, {}, edit('extra.py', b'print(4)\n')),
            ('missing helper', 65, {}, drop_ops('verify-image.sh')),
            ('extra migration', 72, {}, extra_migration),
            ('missing migration', 72, {}, drop_migration),
            ('changed migration', 72, {}, alter_migration),
            ('reordered/renamed migration', 72, {}, rename_migration),
            ('window expired', 73, {'now': '2026-10-23T14:00:01Z'}, None),
            ('window not started', 73, {'now': '2026-10-23T11:59:59Z'}, None),
            ('now is not RFC3339Z', 64, {'now': 'tomorrow'}, None),
        ]
        for name, code, kwargs, mutate in cases:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as case:
                case = pathlib.Path(case)
                shutil.copytree(self.mig, case / 'mig')
                shutil.copytree(self.ops, case / 'ops')
                if mutate:
                    mutate(case / 'mig', case / 'ops')
                done = self.verify(mig=case / 'mig', ops=case / 'ops', **kwargs)
                self.assertEqual(done.returncode, code, done.stderr)
                self.assertEqual(done.stdout, '')

    def test_candidate_schema_is_closed_and_strictly_typed(self):
        def top(key, value):
            return lambda c: c.__setitem__(key, value)

        def nested(section, key, value):
            return lambda c: c[section].__setitem__(key, value)

        cases = {
            'unknown top-level field': top('allowed_trees', ['b' * 40]),
            'schema is bool': top('schema', True),
            'schema is 2': top('schema', 2),
            'image platform changed': nested('image', 'platform', 'linux/amd64'),
            'migrations count is bool': nested('migrations', 'count', True),
            'migrations aggregate tampered': nested('migrations', 'aggregate_sha256', '0' * 64),
            'ops aggregate tampered': nested('ops_package', 'aggregate_sha256', '0' * 64),
            'deploy sha not in package': top('deploy_script_sha256', '0' * 64),
            'window measured is bool': nested('window', 'measured_seconds', True),
            'window measured is zero': nested('window', 'measured_seconds', 0),
            'ci unknown field': nested('ci', 'extra', 'x'),
            'gate not green': nested('gates', 'GATE-001', 'red'),
            'tested head not a sha': top('tested_head', 'main'),
        }
        for name, mutate in cases.items():
            with self.subTest(name=name):
                data = json.loads(self.candidate.read_text())
                mutate(data)
                bad = write(self.tmp / 'bad.json', json.dumps(data).encode())
                done = self.verify(candidate=bad)
                self.assertEqual(done.returncode, 70, done.stderr)
        for name, content in {'invalid json': b'{', 'not an object': b'[]', 'empty': b''}.items():
            with self.subTest(name=name):
                bad = write(self.tmp / 'bad.json', content)
                self.assertEqual(self.verify(candidate=bad).returncode, 70)
        self.assertEqual(self.verify(candidate=self.tmp / 'absent.json').returncode, 70)


def git(repo, *args, env=None):
    done = subprocess.run(['git', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid',
                           '-c', 'commit.gpgsign=false', '-C', str(repo), *args],
                          text=True, capture_output=True, check=True, env=env)
    return done.stdout.strip()


class GitRepoCase(unittest.TestCase):
    """Real git repositories: tree identity, ancestry and squash/main-advance races."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.tmp = pathlib.Path(self._tmp.name)
        self.repo = self.tmp / 'repo'
        self.repo.mkdir()
        git(self.repo, 'init', '-q', '-b', 'main')
        write(self.repo / 'base.txt', b'base\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-q', '-m', 'base')
        self.main = git(self.repo, 'rev-parse', 'HEAD')
        git(self.repo, 'checkout', '-q', '-b', 'feature')
        write(self.repo / 'feature.txt', b'feature\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-q', '-m', 'feature')
        self.head = git(self.repo, 'rev-parse', 'HEAD')
        self.tree = git(self.repo, 'rev-parse', 'HEAD^{tree}')

    def facts(self, **overrides):
        facts = good_facts()
        facts.update(tested_head=self.head, tested_tree=self.tree, base_main=self.main)
        facts['ci'].update(head_sha=self.head, tree=self.tree)
        facts.update(overrides)
        return facts

    def seal(self, facts):
        ops = OpsPackageTests().make_ops(self.tmp)
        mig = self.tmp / 'drizzle'
        mig.mkdir(exist_ok=True)
        write(mig / '20260101000000_a.sql', b'select 1;\n')
        facts_path = write(self.tmp / 'facts.json', json.dumps(facts).encode())
        return manifest('seal', '--facts', facts_path, '--migrations-dir', mig, '--ops-dir', ops,
                        '--out', self.tmp / 'candidate.json', '--repo', self.repo), ops, mig


class GitIdentityTests(GitRepoCase):
    def test_tree_command_prints_the_git_tree_of_a_revision(self):
        done = manifest('tree', 'feature', '--repo', self.repo)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout), {'tree': self.tree})

    def test_seal_with_repo_binds_candidate_to_real_head_tree_and_main_ancestry(self):
        ok, _, _ = self.seal(self.facts())
        self.assertEqual(ok.returncode, 0, ok.stderr)
        other_tree = self.facts()
        other_tree['tested_tree'] = '9' * 40
        other_tree['ci']['tree'] = '9' * 40
        self.assertEqual(self.seal(other_tree)[0].returncode, 71)
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'checkout', '-q', '-b', 'diverged-main')
        write(self.repo / 'other.txt', b'other\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-q', '-m', 'main moved')
        advanced = git(self.repo, 'rev-parse', 'HEAD')
        self.assertEqual(self.seal(self.facts(base_main=advanced))[0].returncode, 71)

    def test_squash_commit_with_the_tested_tree_verifies_but_advanced_main_does_not(self):
        sealed, ops, mig = self.seal(self.facts())
        self.assertEqual(sealed.returncode, 0, sealed.stderr)
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'merge', '--squash', 'feature')
        git(self.repo, 'commit', '-q', '-m', 'squash')
        squash = git(self.repo, 'rev-parse', 'HEAD')
        squash_tree = git(self.repo, 'rev-parse', 'HEAD^{tree}')
        self.assertNotEqual(squash, self.head)
        verify = lambda tree, commit: manifest(
            'verify-release', '--candidate', self.tmp / 'candidate.json', '--release-tree', tree,
            '--release-commit', commit, '--digest', DIGEST, '--now', NOW, '--migrations-dir', mig, '--ops-dir', ops)
        accepted = verify(squash_tree, squash)
        self.assertEqual(accepted.returncode, 0, accepted.stderr)
        self.assertEqual(json.loads(accepted.stdout)['release_commit_is_tested_head'], False)
        write(self.repo / 'later.txt', b'later\n')
        git(self.repo, 'add', '.')
        git(self.repo, 'commit', '-q', '-m', 'unrelated change landed on main')
        later = git(self.repo, 'rev-parse', 'HEAD')
        self.assertEqual(verify(git(self.repo, 'rev-parse', 'HEAD^{tree}'), later).returncode, 71)


class ReleaseFactsTests(GitRepoCase):
    """What the deploy workflow computes before building: commit, tree and migrations of the checked-out main."""

    def facts_cmd(self, *extra):
        mig = self.repo / 'drizzle'
        mig.mkdir(exist_ok=True)
        write(mig / '20260101000000_a.sql', b'select 1;\n')
        return manifest('release-facts', '--repo', self.repo, '--migrations-dir', mig, *extra)

    def test_release_facts_are_github_output_lines_for_the_checked_out_head(self):
        done = self.facts_cmd()
        self.assertEqual(done.returncode, 0, done.stderr)
        lines = dict(line.split('=', 1) for line in done.stdout.splitlines())
        migrations = json.loads(manifest('migrations', self.repo / 'drizzle').stdout)
        self.assertEqual(lines, {'sha': self.head, 'tree': self.tree,
                                 'migrations_aggregate': migrations['aggregate_sha256'],
                                 'migrations_count': str(migrations['count'])})

    def test_main_that_advanced_past_the_expected_sha_is_refused_with_71(self):
        self.assertEqual(self.facts_cmd('--expect', self.head).returncode, 0)
        done = self.facts_cmd('--expect', self.main)
        self.assertEqual(done.returncode, 71, done.stderr)
        self.assertEqual(done.stdout, '')
        self.assertEqual(self.facts_cmd('--expect', 'HEAD; rm -rf').returncode, 64)

    def test_squash_commit_keeps_the_tree_and_an_extra_migration_changes_the_aggregate(self):
        before = dict(l.split('=', 1) for l in self.facts_cmd().stdout.splitlines())
        git(self.repo, 'checkout', '-q', 'main')
        git(self.repo, 'merge', '--squash', 'feature')
        git(self.repo, 'commit', '-q', '-m', 'squash')
        squashed = dict(l.split('=', 1) for l in self.facts_cmd().stdout.splitlines())
        self.assertNotEqual(squashed['sha'], before['sha'])
        self.assertEqual(squashed['tree'], before['tree'])
        write(self.repo / 'drizzle' / '20260105000000_extra.sql', b'select 9;\n')
        extra = dict(l.split('=', 1) for l in self.facts_cmd().stdout.splitlines())
        self.assertNotEqual(extra['migrations_aggregate'], before['migrations_aggregate'])
        self.assertEqual(extra['migrations_count'], '2')


if __name__ == '__main__':
    unittest.main()
