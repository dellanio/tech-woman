"""INT-006: guarda do teardown das suítes PostgreSQL (tests/pg).

pg-pool resolve end() antes de o backend sair; um DROP DATABASE ... WITH (FORCE) logo em seguida termina esse
backend e o FATAL 57P01 ("terminating connection due to administrator command") chega a um cliente sem listener,
falhando um teste qualquer de forma intermitente (CI #40143692992, INT-006 r1). O padrão já corrigido em
1fae897 é esperar pg_stat_activity esvaziar (settled) antes do DROP.
"""
import pathlib, re, unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
DROP = re.compile(r'drop database[^`]*with \(force\)', re.IGNORECASE)


class PgTeardownTests(unittest.TestCase):
    def test_every_forced_drop_of_a_test_database_waits_for_its_backends_first(self):
        missing = []
        for path in sorted((ROOT / 'tests/pg').glob('*.test.ts')):
            text = path.read_text(encoding='utf-8')
            for match in DROP.finditer(text):
                before = text[max(0, match.start() - 400):match.start()]
                if 'await settled(' not in before:
                    missing.append('%s:%d' % (path.name, text.count('\n', 0, match.start()) + 1))
        self.assertEqual(missing, [], 'DROP ... WITH (FORCE) sem aguardar settled(control,db) antes')


if __name__ == '__main__':
    unittest.main()
