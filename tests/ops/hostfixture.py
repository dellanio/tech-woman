"""Synthetic host for gate/stage/cutover tests: staged ops package, sealed candidate, scratch state dir."""
import datetime, json, os, pathlib, subprocess, sys, tempfile

from tests.ops import harness

DIGEST = 'sha256:' + '1' * 64
COMMIT = 'a' * 40
TREE = 'b' * 40
SECRET = 'TEST-ONLY-SECRET_token.value'
MIGRATIONS = {'20260101000000_a.sql': b'select 1;\n', '20260102000000_b.sql': b'select 2;\n'}


def stamp(offset_seconds):
    moment = datetime.datetime.now(datetime.timezone.utc) + datetime.timedelta(seconds=offset_seconds)
    return moment.strftime('%Y-%m-%dT%H:%M:%SZ')


def run_py(*args, stdin=None):
    return subprocess.run([sys.executable, '-I', *map(str, args)], input=stdin, text=True, capture_output=True)


class Host:
    def __init__(self, test):
        self.ops = harness.StagedOps()
        test.addCleanup(self.ops.cleanup)
        self.state_dir = self.ops.host / 'state'
        self.work = self.ops.host / 'work'
        self.mig = self.work / 'drizzle'
        self.mig.mkdir(parents=True)
        for name, data in MIGRATIONS.items():
            (self.mig / name).write_bytes(data)

    def facts(self, authorized=-3600, expires=3600):
        return {
            'tested_head': COMMIT, 'tested_tree': TREE, 'base_main': 'c' * 40,
            'ci': {'run_id': '1', 'conclusion': 'success', 'head_sha': COMMIT, 'tree': TREE},
            'gates': {'GATE-001': 'green', 'GATE-002': 'green', 'GATE-003': 'green'},
            'window': {'decision_ref': 'dec-1', 'authorized_at': stamp(authorized), 'expires_at': stamp(expires),
                       'measured_seconds': 900},
            'recovery_evidence_sha256': 'd' * 64, 'rpo_declared': 'ate 24h (dump diario)',
        }

    def seal(self, facts=None):
        facts_path = self.work / 'facts.json'
        facts_path.write_text(json.dumps(facts or self.facts()))
        done = run_py(self.ops.ops / 'manifest.py', 'seal', '--facts', facts_path, '--migrations-dir', self.mig,
                      '--ops-dir', self.ops.ops, '--out', self.state_dir / 'candidate.json')
        assert done.returncode == 0, done.stderr
        os.chmod(self.state_dir / 'candidate.json', 0o644)
        return json.loads((self.state_dir / 'candidate.json').read_text())

    def cutover(self, *args):
        return run_py(self.ops.ops / 'cutover.py', *args)

    def migrations(self):
        return json.loads(run_py(self.ops.ops / 'manifest.py', 'migrations', self.mig).stdout)

    def deploy_request(self, **changes):
        migrations = self.migrations()
        fields = {'header': 'TWDEPLOY/2', 'op': 'deploy', 'digest': DIGEST, 'commit': COMMIT, 'tree': TREE,
                  'aggregate': migrations['aggregate_sha256'], 'count': str(migrations['count']), 'token': SECRET}
        fields.update(changes)
        return ''.join(fields[k] + '\n' for k in ('header', 'op', 'digest', 'commit', 'tree', 'aggregate', 'count',
                                                   'token'))

    def deploy(self, **changes):
        return self.ops.run(self.deploy_request(**changes))
