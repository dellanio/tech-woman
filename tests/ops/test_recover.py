"""S10 input and phase negatives of the recovery commands (hermetic fakes; the PostgreSQL behaviour itself is
proven against a real PostgreSQL 16 in tests/ops/pg/test_recovery_pg.py)."""
import os, unittest

from tests.ops import harness
from tests.ops.hostfixture import Host

cutover = harness.load_ops_module('cutover')


class RecoverRefusalTests(unittest.TestCase):
    def host_in(self, phase):
        host = Host(self)
        self.addCleanup(host.sqlite()[1].close)
        if phase == 'pg_write_open':
            host.pg_open()
        else:
            _, state = host.imported()
            if phase == 'activated':
                state.transition('activated', '2026-10-23T12:00:00Z')
        return host

    def assert_untouched(self, host, done, code):
        self.assertEqual(done.returncode, code, done.stderr)
        self.assertEqual([c for c in host.cutover_calls() if c['cmd'] == 'docker'], [])

    def test_hostile_or_malformed_arguments_are_64_before_anything_runs(self):
        host = self.host_in('pg_write_open')
        before = cutover.State.load(host.state_dir, cutover.UNCHECKED).seq
        (host.ops.host / 'backups' / 'real.dump').write_bytes(b'PGDMP')
        cases = [['--mode', 'delete'], ['--mode', 'restart', '--dump', 'real.dump'], ['--mode', 'compare'],
                 ['--mode', 'compare', '--dump', '../state/state.json'], ['--mode', 'compare', '--dump', 'a;rm -rf x.dump'],
                 ['--mode', 'compare', '--dump', '$(id).dump'], ['--mode', 'compare', '--dump', 'real.dump\nx'],
                 ['--mode', 'compare', '--dump', 'missing.dump'], ['--mode', 'compare', '--dump', '/etc/passwd'],
                 ['--mode'], ['--db', 'postgres', '--mode', 'reconcile']]
        if os.name == 'posix':
            os.symlink(host.state_dir / 'state.json', host.ops.host / 'backups' / 'link.dump')
            cases.append(['--mode', 'compare', '--dump', 'link.dump'])
        for args in cases:
            with self.subTest(args=args):
                done = host.cutover('recover', *args)
                self.assert_untouched(host, done, 64)
                self.assertNotIn('rm -rf', done.stderr)
        self.assertEqual(cutover.State.load(host.state_dir, cutover.UNCHECKED).seq, before)

    def test_recovery_commands_need_a_postgres_phase_and_never_touch_sqlite(self):
        for phase in ('imported', 'activated'):
            host = self.host_in(phase)
            for args in (['recover', '--mode', 'restart'], ['recover', '--mode', 'reconcile'], ['record-first-write']):
                with self.subTest(phase=phase, args=args):
                    self.assert_untouched(host, host.cutover(*args), 75)
                    self.assertEqual(cutover.State.load(host.state_dir, cutover.UNCHECKED).phase, phase)


if __name__ == '__main__':
    unittest.main()
