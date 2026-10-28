"""INT-005 (R-008) + AJUSTE-INSCRICAO: `pnpm test:e2e` aponta para o e2e atual da API v1 (crossing → cadastro definitivo 202 → login full →
restart, sem senha temporária no caminho normal; entrypoint real do mailer com job legado), não para o legado."""
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class E2eTargetTests(unittest.TestCase):
    def test_script_points_to_v1_flow(self):
        scripts = json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['scripts']
        self.assertEqual(scripts['test:e2e'], 'tsx tests/pg/e2e-v1.ts')
        self.assertFalse((ROOT / 'tests/pg/legacy-e2e.ts').exists(), 'e2e legado obsoleto (protocolo/token antigo) removido')

    def test_flow_covers_v1_contract_and_separated_credentials(self):
        source = (ROOT / 'tests/pg/e2e-v1.ts').read_text(encoding='utf-8')
        for needle in ('/api/v1/registrations/participants/preview', '/api/v1/registrations/participants', '202',
                       "next:'login'", '/api/v1/auth/login', "{state:'authenticated'}", 'passwordConfirmation',
                       'scripts/email-worker.ts', 'scripts/migration/migrate.ts', 'bootstrap-local.sql', 'MAILER_DATABASE_URL', 'restart'):
            self.assertIn(needle, source, needle)
        self.assertNotIn('/api/participant', source, 'sem API legada')
        self.assertNotIn('/api/v1/auth/password/change', source, 'cadastro definitivo: sem troca de senha temporária no caminho normal')
        self.assertNotIn('password_change_required', source, 'login direto em sessão full')


if __name__ == '__main__':
    unittest.main()
