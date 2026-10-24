"""S14 — what WP-005 must never change: merge policy, CODEOWNERS, the `check` gate, secrets, and its own file ownership."""
import hashlib, pathlib, re, subprocess, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
BASE = 'aadb3cbe3ae3e1fde2d569abbf71af60f2d711f0'
# LF sha256 of the files at the WP-005 base commit (fixed here, not recomputed from git)
FROZEN = {'.github/workflows/approved-merge.yml': '28c6f631de74f9986835b9e6df86b068c0fe3b1c92918b20e2a0c124b748cead',
          '.github/CODEOWNERS': '7596ee90b231e4f58321c9255a324c568dc551174e5dc0c2348501fa375ccf13'}
OWNED = re.compile(r'^(\.github/workflows/(ci|deploy)\.yml|ops/|tests/(test_deploy|test_merge_policy)\.py|tests/ops/'
                   r'|docs/operations-postgres\.md$)')


def lf(path):
    return (ROOT / path).read_bytes().replace(b'\r\n', b'\n')


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, check=True).stdout.decode()


class PolicyPreservedTests(unittest.TestCase):
    def test_merge_policy_and_codeowners_are_byte_identical_to_the_base(self):
        for path, digest in FROZEN.items():
            self.assertEqual(hashlib.sha256(lf(path)).hexdigest(), digest, path)

    def test_every_changed_file_is_inside_the_wp005_ownership(self):
        changed = [p for p in git('diff', '--name-only', BASE, 'HEAD').splitlines() if p]
        # untracked new files too (not `git status`: a Linux git reading this Windows CRLF checkout sees every file as modified)
        changed += [p for p in git('ls-files', '--others', '--exclude-standard').splitlines() if p]
        self.assertTrue(changed)
        self.assertEqual(sorted({p for p in changed if not OWNED.match(p)}), [])

    def test_gates_and_secrets_are_the_base_ones(self):
        deploy, ci = lf('.github/workflows/deploy.yml').decode(), lf('.github/workflows/ci.yml').decode()
        self.assertIn("needs.gate.outputs.deploy == 'true'", deploy)
        self.assertIn('  check:\n    name: check\n', ci)
        base_deploy = git('show', '%s:.github/workflows/deploy.yml' % BASE).replace('\r\n', '\n')
        secrets = lambda text: sorted(set(re.findall(r'secrets\.([A-Za-z_]+)', text)))
        self.assertEqual(secrets(deploy), secrets(base_deploy))
        self.assertEqual(secrets(ci), [])
        for text in (deploy, ci):
            for forbidden in ('bypass', 'pull_request_target', '--admin', 'workflow_run.head_sha'):
                self.assertNotIn(forbidden, text)


if __name__ == '__main__':
    unittest.main()
