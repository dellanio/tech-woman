"""OPS-001 #1 and the GATE-003 limits flake, as fixed facts of the ops package.

- paths.env must name the PostgreSQL container that really exists on the OCI host (`postgres`, OPS-001 read-only
  inventory and inventario-oci), and the runbook's inventory table must state the same values: a wrong name makes
  every cutover/backup step fail closed at deploy time.
- tests/ops/pg/limits.test.ts compares arrays of pg_db_role_setting rows: the query must order them by a total key
  (role, database, config), otherwise two rows of the same role come back in any order (GATE-003 §3).
"""
import pathlib, re, unittest

ROOT = pathlib.Path(__file__).resolve().parents[2]
INVENTORY = {'TW_PG_CONTAINER': 'postgres', 'TW_NETWORK': 'dellaniocom_default', 'TW_PG_DB': 'techwoman'}


def paths_env():
    return dict(line.split('=', 1) for line in (ROOT / 'ops/paths.env').read_text(encoding='utf-8').splitlines()
                if line and not line.startswith('#'))


class InventoryTests(unittest.TestCase):
    def test_paths_env_names_the_real_postgres_container_of_the_host(self):
        values = paths_env()
        for key, expected in INVENTORY.items():
            with self.subTest(key=key):
                self.assertEqual(values[key], expected)
        self.assertNotIn('dellaniocom-postgres', (ROOT / 'ops/paths.env').read_text(encoding='utf-8'))

    def test_the_runbook_inventory_matches_paths_env(self):
        doc = (ROOT / 'docs/operations-postgres.md').read_text(encoding='utf-8')
        values = paths_env()
        for key in INVENTORY:
            with self.subTest(key=key):
                self.assertIn('`%s=%s`' % (key, values[key]), doc)
        self.assertNotIn('dellaniocom-postgres', doc)


class LimitsOrderingTests(unittest.TestCase):
    def test_role_settings_query_has_a_total_order(self):
        text = (ROOT / 'tests/ops/pg/limits.test.ts').read_text(encoding='utf-8')
        query = re.search(r'async function settings\(db: Pool\) \{(.*?)\n\}', text, re.S).group(1)
        order = re.search(r'order by ([^`]+?)`', query, re.I).group(1).strip()
        self.assertEqual([part.strip() for part in order.split(',')], ['1', '2', 's.setconfig::text'], order)


if __name__ == '__main__':
    unittest.main()
