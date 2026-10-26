"""WP006-R5: a migration incremental carrega journal e snapshot com timestamp."""
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
TAG = '20261026140000_beatriz_read_only'


class ReadOnlyMigrationMetadataTests(unittest.TestCase):
    def test_read_only_setting_is_a_fixed_literal_in_the_limits_values(self):
        sql = (ROOT / 'ops/sql/role-limits.sql').read_text()
        self.assertIn("('techwoman_beatriz', 'default_transaction_read_only', 'on')", sql)
        self.assertNotIn(":'beatriz_read_only'", sql)

    def test_read_only_migration_has_timestamped_snapshot_and_journal(self):
        journal = json.loads((ROOT / 'drizzle/meta/_journal.json').read_text())
        entries = [entry for entry in journal['entries'] if entry['tag'] == TAG]
        self.assertEqual(len(entries), 1, 'migration read-only precisa constar no journal')
        entry = entries[0]
        self.assertTrue(entry['breakpoints'])
        self.assertEqual(entry['version'], journal['version'])
        self.assertEqual(entry['when'], 1793023200000)
        snapshot_path = ROOT / 'drizzle/meta/20261026140000_snapshot.json'
        self.assertTrue(snapshot_path.is_file(), 'snapshot precisa usar o mesmo timestamp')
        snapshot = json.loads(snapshot_path.read_text())
        previous = json.loads((ROOT / 'drizzle/meta/20261022230634_snapshot.json').read_text())
        self.assertEqual(snapshot['prevId'], previous['id'])
        self.assertNotEqual(snapshot['id'], previous['id'])
        self.assertEqual(snapshot['dialect'], 'postgresql')
        self.assertEqual(snapshot['tables'], previous['tables'], 'migration custom de ACL não altera a estrutura declarativa do snapshot')


if __name__ == '__main__':
    unittest.main()
