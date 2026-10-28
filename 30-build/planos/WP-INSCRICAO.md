# WP-INSCRICAO — ledger de progresso, evidências e decisões (t_e5584a38)

Plano: `30-build/specs/AJUSTE-INSCRICAO.md`. Evidência durável: `/fabrica/tech-woman/40-verificacao/t_e5584a38/` (logs em `logs/`).
Base: `59ab4a8`. PG16 local: cluster `.local-pg/data` (porta 55438, `127.0.0.1`, superusuária sintética `twlocal`).
Comandos de teste usam `MIGRATION_DATABASE_URL=postgresql://twlocal:<sintética>@127.0.0.1:55438/postgres`.

## Ambiente

- `apt-get install postgresql-16` (16.15-0ubuntu0.24.04.1), `create_main_cluster=false`, `policy-rc.d` negou start de serviço → nenhum cluster/serviço do sistema.
- `initdb -U twlocal -A scram-sha-256 -E UTF8 --locale=C.UTF-8`; `pg_ctl ... -p 55438 -c listen_addresses=127.0.0.1`.
- Logs: `logs/apt-install-pg16.log`, `logs/initdb.log`.

## Linha de base (59ab4a8, antes de qualquer mudança)

| Comando | Resultado | Log |
|---|---|---|
| `BUILDING=1 DATABASE_URL=…:1/unavailable pnpm build` | rc=0 (4m03s) | `logs/baseline-build.log` |
| `TEST_STANDALONE=1 pnpm test:pg` | (preencher) | `logs/baseline-test-pg.log` |

## Ciclos TDD

(cada linha: tarefa, comando, RED observado, GREEN observado, log)

## Decisões

Ver seção "Decisões" do plano (D1–D7). Adições durante a execução ficam aqui.
