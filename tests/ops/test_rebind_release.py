import hashlib, json, unittest

from tests.ops import harness
from tests.ops.hostfixture import DIGEST, Host, OLD_PG_DIGEST, ORIGINAL_IP

cutover = harness.load_ops_module('cutover')
NEW_TREE = '9' * 40
NEW_COMMIT = '8' * 40


class RebindTestCase(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)
        self.host.pg_open()
        self.host.good_image(commit=NEW_COMMIT)

    def state(self):
        return cutover.State.load(self.host.state_dir, cutover.UNCHECKED)

    def seal_next(self, tree=NEW_TREE, **window):
        facts = self.host.facts(**window)
        facts['tested_tree'] = tree
        facts['ci']['tree'] = tree
        facts['tested_head'] = facts['ci']['head_sha'] = NEW_COMMIT
        return self.host.seal(facts)


class RebindTests(RebindTestCase):
    def test_a_release_of_another_tree_needs_a_sealed_candidate_the_operator_rebinds(self):
        before = self.state().seq
        denied = self.host.deploy(commit=NEW_COMMIT, tree=NEW_TREE)
        self.assertEqual(denied.returncode, 71, denied.stderr)  # the old candidate does not cover this tree
        self.seal_next()
        denied = self.host.deploy(commit=NEW_COMMIT, tree=NEW_TREE)
        self.assertEqual(denied.returncode, 70, denied.stderr)  # sealed but not recorded by the operator yet
        done = self.host.cutover('rebind')
        self.assertEqual(done.returncode, 0, done.stderr)
        state = self.state()
        self.assertEqual((state.phase, state.seq), ('pg_write_open', before + 1))
        self.assertEqual(state.candidate_sha256,
                         hashlib.sha256((self.host.state_dir / 'candidate.json').read_bytes()).hexdigest())
        released = self.host.deploy(commit=NEW_COMMIT, tree=NEW_TREE)
        self.assertEqual(released.returncode, 0, released.stderr)
        self.assertEqual(json.loads(released.stdout)['op'], 'release')

    def test_rebind_refuses_a_schema_change_a_wrong_phase_drift_or_an_expired_window(self):
        before = self.state().seq
        # schema change: another migrations directory
        (self.host.mig / '20260105000000_extra.sql').write_bytes(b'select 9;\n')
        self.seal_next()
        self.assertEqual(self.host.cutover('rebind').returncode, 72)
        (self.host.mig / '20260105000000_extra.sql').unlink()
        self.seal_next(authorized=-7200, expires=-3600)
        self.assertEqual(self.host.cutover('rebind').returncode, 73)
        self.seal_next()
        (self.host.ops.ops / 'extra.py').write_bytes(b'print(1)\n')
        self.assertEqual(self.host.cutover('rebind').returncode, 65)
        (self.host.ops.ops / 'extra.py').unlink()
        self.assertEqual(self.state().seq, before)
        self.state().transition('recovering', '2026-10-23T12:00:00Z')
        self.assertEqual(self.host.cutover('rebind').returncode, 75)


class RegisterReleaseTests(RebindTestCase):
    def released(self):
        self.seal_next()
        self.assertEqual(self.host.cutover('rebind').returncode, 0)
        result = self.host.deploy(commit=NEW_COMMIT, tree=NEW_TREE)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_the_operator_records_the_released_image_as_known_and_last_good(self):
        attestation = self.released()
        (self.host.ops.fake / 'container-inspect').write_bytes(
            ('ghcr.io/dellanio/tech-woman@%s|%s\n' % (DIGEST, ORIGINAL_IP)).encode())
        done = self.host.cutover('register-release', stdin=attestation)
        self.assertEqual(done.returncode, 0, done.stderr)
        state = self.state()
        self.assertEqual(state.data['known_pg_images'], [OLD_PG_DIGEST, DIGEST])
        self.assertEqual(state.data['last_good_pg_image'], DIGEST)
        again = self.host.cutover('register-release', stdin=attestation)
        self.assertEqual(again.returncode, 0, again.stderr)
        self.assertEqual(self.state().data['known_pg_images'], [OLD_PG_DIGEST, DIGEST])

    def test_registration_needs_the_running_web_to_be_that_image_and_a_matching_attestation(self):
        attestation = self.released()  # the fake still reports the OLD image as the running web
        self.assertEqual(self.host.cutover('register-release', stdin=attestation).returncode, 74)
        (self.host.ops.fake / 'container-inspect').write_bytes(
            ('ghcr.io/dellanio/tech-woman@%s|%s\n' % (DIGEST, ORIGINAL_IP)).encode())
        broken = json.loads(attestation)
        broken['attestation']['candidate_sha256'] = 'e' * 64
        self.assertEqual(self.host.cutover('register-release', stdin=json.dumps(broken)).returncode, 70)
        self.assertEqual(self.host.cutover('register-release', stdin='nope').returncode, 64)
        self.assertEqual(self.state().data['known_pg_images'], [OLD_PG_DIGEST])


if __name__ == '__main__':
    unittest.main()
