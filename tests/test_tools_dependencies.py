"""Contrato da imagem: /tools contém só dependências necessárias à operação."""
import json
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]


class ToolsDependenciesTests(unittest.TestCase):
    def test_runtime_tools_are_installed_from_production_dependencies(self):
        package = json.loads((ROOT / 'package.json').read_text())
        self.assertIn('tsx', package['dependencies'])
        for tool in ('typescript', 'playwright', 'drizzle-kit'):
            self.assertNotIn(tool, package['dependencies'])
        dockerfile = (ROOT / 'Dockerfile').read_text()
        self.assertIn('pnpm install --prod --frozen-lockfile', dockerfile)
        self.assertIn('COPY --from=tools-deps /tools/node_modules /tools/node_modules', dockerfile)
        self.assertNotIn('COPY --from=build /app/node_modules /tools/node_modules', dockerfile)


if __name__ == '__main__':
    unittest.main()
