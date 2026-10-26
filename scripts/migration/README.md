# WP-001 — comandos locais e ferramentas offline

Protótipo local de migração PostgreSQL, **não pronto para produção**. Fonte/branch: `evolution/wp-001`; não usar `repo/` histórico. Não executar com dados ou credenciais reais no sandbox.

## Subir com um comando após configurar ambiente

1. Copie `.env.example` para `.env` **local, fora do git**, e substitua TODOS os placeholders por valores exclusivos. Prefira senhas aleatórias hex (sem caracteres reservados de URL). ADMIN_EMAIL deve ser endereço sintético `example.invalid`; ADMIN_PASSWORD ≥16 caracteres. SESSION_SECRET ≥32 caracteres. Não reutilize credenciais do host.
2. `docker compose up --build` sobe PG16 com volume persistente → migrador separado → seed sintético explícito → web em `http://localhost:3000`. PG só em `127.0.0.1:55432`. A composição é SOMENTE local; não provisiona produção.
3. Web não recebe `.env` inteiro, ADMIN_PASSWORD ou MIGRATION_DATABASE_URL. `migrate` recebe só credencial DDL; `seed` é processo offline separado. Não remover volumes.

Alternativa nativa (usada na prova deste sandbox): PostgreSQL16 local existente + variáveis de ambiente por processo; `pnpm install --frozen-lockfile`; `pnpm db:migrate` com MIGRATION_DATABASE_URL; `pnpm seed:demo` com DATABASE_URL da conexão migradora e LOCAL_SEED=1; depois **web somente com DATABASE_URL runtime**, APP_ORIGIN, SESSION_SECRET e EMAIL_MODE=fake: `pnpm dev`.

Migrations são todos os arquivos `drizzle/*.sql` em ordem lexical, checksum normalizado LF, lock e transação única em `scripts/migration/migrate.ts`. `pnpm db:migrate` é o comando canônico; importar `src/lib/*` não migra. As migrations SQL complementares também estão no journal. Não editar arquivo já aplicado: adicionar migration nova.

O seed só existe no comando explícito; não roda no import/build/boot e não é executado pelo importador. `LOCAL_ROLE_SETUP=1` aplica grants de **compatibilidade local WP-001**, não a política final de identidade/Agenda dos WP-002/003/OPS.

## SQLite → PostgreSQL, somente offline

- `python3 scripts/migration/snapshot.py --backup ORIGEM DESTINO` usa Backup API read-only (WAL aberto suportado), não sobrescreve arquivos, valida integrity/FKs; cópia privada com modo0600.
- `pnpm db:import CÓPIA --dry-run` lê a cópia e relata somente contagens/pendências; não abre conexão PG nem escreve.
- `MIGRATION_DATABASE_URL=<conexão protegida migradora> pnpm db:import CÓPIA` importa em destino **vazio/isolado**, sem e-mail/seed. Repetir a mesma cópia é no-op identificado por checksum lógico. Outra cópia em PG já escrito é recusada: não é sincronizador de produção.
- O arquivo privado `legacy_snapshot.source_table/source_row` preserva DDL, todas colunas/células tipadas: inteiros como texto decimal, BLOB base64, float hexadecimal, texto exato e NULL distinto. **NUNCA publique stdout de `snapshot.py --read`, dumps, hashes individuais ou mapas de identidade.**
- Domínio mantém IDs/tokens/hash, JSON equivalente, timestamps válidos e raw. Campo/JSON estranho vira pendência; sem `[]` ou timestamp histórico inventado. Se uma linha não puder ser materializada, seu bruto permanece no arquivo privado e o run não pode ser tratado como pronto para corte.
- Sequences superam maxID e sqlite_sequence (inclusive IDs apagados). Sem inferir tema/turma/horário de dados antigos.
- Grupos de admin que normalizam igual não escolhem hash/conta; ambos ficam arquivados e bloqueantes, mapa `credential_conflict`. Candidatos de domínio privilegiados ficam sem user_id, com `privileged_candidate`. Domínios inequívocos aguardam prova de e-mail; não recebem posse por coincidência. Resolução operacional e filtros finais pertencem aos próximos WPs, sobre o mapa privado desta origem.

## Testes e build

- `pnpm test:pg` exige MIGRATION_DATABASE_URL de uma **instância sintética de teste PG16** cujo usuário possa criar bases/roles isoladas; nunca usar o runtime ou produção. Testes criam bases com prefixos tw_/wp1_, preservadas para diagnóstico. Também requer Python3, pg_dump/pg_restore e Docker CLI/Compose para validar a configuração (sem daemon para esse teste).
- `TEST_STANDALONE=1 pnpm test:pg` reaproveita o build standalone para os mesmos contratos HTTP (executar build antes; static/public copiados como no e2e). Sem a flag, usa Next dev; prontidão pode levar até300s em mount Windows9p frio. Nenhuma assertion é removida.
- `pnpm typecheck`; `pnpm test:unit` executa os testes Python existentes. Checkout Windows CRLF causa falha herdada em `ops/deploy.sh` quando Bash Linux lê os bytes; mesmos blobs Git LF passam4/4. Não se alterou ops/política fora de ownership. WP-005/INT deve tratar portabilidade/checkout sem desativar testes.
- `DATABASE_URL=<endereço indisponível> NEXT_TELEMETRY_DISABLED=1 pnpm build` não consulta PG, não faz DDL nem seed.
- `MIGRATION_DATABASE_URL=<PG16 sintético> pnpm test:e2e` (depois de `pnpm build`, com `psql` no PATH) roda `tests/pg/e2e-v1.ts`: base vazia → bootstrap de roles → migradora em processo próprio → web standalone só com a credencial runtime → cadastro 202 → job → worker fake em memória → login com temporária → troca → reinício do web, mais o entrypoint `scripts/email-worker.ts --once`. Modo `E2E_EXTERNAL=1` reutiliza o fluxo contra a imagem final. Credenciais sintéticas geradas pelo próprio teste, nunca impressas; o fake não atesta entrega SES.

## Imagem e fronteiras

Web standalone em `/app`; ferramentas offline e scripts futuros de worker em `/tools`, com Python/tsx/dependências/migrations. Migrador: trabalhar em `/tools` e executar `node --import tsx scripts/migration/migrate.ts`; worker real será `scripts/email-worker.ts` do WP-002 (não há stub alegado pronto). Não passar segredo migrador ao web/mailer.

Neste sandbox não há Docker daemon/socket. Compose foi validado e roles separadas/standalone foram executados em PG16 nativo. **Build/run da imagem OCI/ARM não foi executado aqui**: INT/host deve ensaiar a imagem; fluxo cadastro→job→fake→login/troca da imagem depende do WP-002 e é prova final no INT-005. Nenhum envio SES real, OCI, deploy, UI Agenda, merge ou push main.
