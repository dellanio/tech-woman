"""S14 — T16 negative matrix in one table: every denial of the SSH command happens BEFORE any container effect, with
its stable exit code, and no token or injected text is echoed. (Each row also has a focused test elsewhere.)"""
import unittest

from tests.ops.hostfixture import DIGEST, SECRET, Host

NO_EFFECT = ('stop', 'rename', 'rm', 'start', 'network')


def effects(result):
    return [c['args'] for c in result.calls() if c['cmd'] == 'docker' and (
        c['args'][0] in NO_EFFECT or (c['args'][0] == 'run' and '-d' in c['args']))]


class T16MatrixTests(unittest.TestCase):
    def check(self, host, code, **changes):
        result = host.deploy(**changes)
        self.assertEqual(result.returncode, code, result.stderr)
        self.assertEqual(effects(result), [])
        result.assert_no_tripwire()
        for leaked in (SECRET, '$(id)', ';reboot', 'rm -rf'):
            self.assertNotIn(leaked, result.stdout + result.stderr)
        return result

    def test_stage_denials(self):
        host = Host(self)
        self.check(host, 70)                                   # no marker
        host.staged()
        host.good_image()
        cases = [
            (64, {'digest': 'latest'}), (64, {'digest': 'sha256:' + '1' * 63 + ';reboot'}),
            (64, {'commit': '$(id)' + 'a' * 35}), (64, {'tree': 'b' * 39 + '\n' + 'rm -rf /'}),
            (64, {'token': SECRET + '\nexec rm -rf /'}), (64, {'count': '2;reboot'}), (64, {'header': 'TWDEPLOY/1'}),
            (71, {'tree': 'c' * 40}), (72, {'aggregate': 'e' * 64}), (72, {'count': '3'}),
        ]
        for code, changes in cases:
            with self.subTest(code=code, changes=sorted(changes)):
                self.check(host, code, **changes)

    def test_phase_window_and_image_denials(self):
        host = Host(self)
        host.window = {'authorized': -7200, 'expires': -3600}
        host.staged()
        host.good_image()
        self.check(host, 73)                                   # stage outside the authorised window
        frozen = Host(self)
        frozen.frozen()
        frozen.good_image()
        self.check(frozen, 75)                                 # marker frozen: deploys are refused
        release = Host(self)
        release.pg_open()
        release.good_image()
        (release.ops.fake / 'container-inspect').write_bytes(
            ('ghcr.io/dellanio/tech-woman@sha256:%s|10.0.0.7\n' % ('0' * 64)).encode())
        self.check(release, 76)                                # running web is the SQLite image: never touched
        release = Host(self)
        release.pg_open()
        release.good_image()
        (release.ops.fake / 'pgdump.rc').write_bytes(b'1')
        self.check(release, 79)                                # pre-release backup failed
        bad_image = Host(self)
        bad_image.staged()
        bad_image.good_image()
        (bad_image.ops.fake / 'inspect').write_bytes(b'amd64|linux|' + b'a' * 40 + b'\n')
        self.check(bad_image, 74)                              # not the ARM build of the release commit


if __name__ == '__main__':
    unittest.main()
