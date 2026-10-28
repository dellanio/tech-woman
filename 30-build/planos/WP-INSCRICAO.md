# WP-INSCRICAO — ledger de progresso, evidências e decisões (t_e5584a38)

Plano: `30-build/specs/AJUSTE-INSCRICAO.md`. Evidência durável: `/fabrica/tech-woman/40-verificacao/t_e5584a38/` (logs em `logs/`).
Base: `59ab4a8`. PG16 local: cluster `.local-pg/data` (porta 55438, `127.0.0.1`, superusuária sintética `twlocal`).
Comandos de teste usam `MIGRATION_DATABASE_URL=postgresql://twlocal:<sintética>@127.0.0.1:55438/postgres` (senha em arquivo local próprio, nunca impressa).

## Ambiente

- `apt-get install postgresql-16` (16.15-0ubuntu0.24.04.1), `create_main_cluster=false`, `policy-rc.d` negou start de serviço → nenhum cluster/serviço do sistema.
- `initdb -U twlocal -A scram-sha-256 -E UTF8 --locale=C.UTF-8`; `pg_ctl ... -p 55438 -c listen_addresses=127.0.0.1` (servidor roda como `postgres`).
- Suítes ops PG (`tests/ops/pg`): cluster descartável próprio `.local-pg/wp005-home/recovery-pg` (porta 55439, trust só em 127.0.0.1), executadas como
  usuário não-root `postgres` com `HOME`/`TMPDIR` duráveis em `.local-pg/wp005-home` (`PG_BIN`/`PG_CLIENT_BIN=/usr/lib/postgresql/16/bin`).
- Docker CLI + compose instalados pelo coordenador às 14:44 (`logs/coordinator-tooling-install.log`); `docker compose config` não precisa de daemon.
- Playwright Chromium em `.browsers` (`PLAYWRIGHT_BROWSERS_PATH`). Logs: `logs/apt-install-pg16.log`, `logs/initdb.log`, `logs/playwright-install.log`.

## Linha de base (59ab4a8, antes de qualquer mudança)

| Comando | Resultado | Log |
|---|---|---|
| `BUILDING=1 DATABASE_URL=…:1/unavailable pnpm build` | rc=0 (4m03s) | `logs/baseline-build.log` |
| `TEST_STANDALONE=1 pnpm test:pg` | 175 pass / 1 fail — `legacy-packaging` R2 `spawnSync docker ENOENT` (ambiente: sem Docker CLI na época) | `logs/baseline-test-pg.log` |

## Ciclos TDD (implementação, commits c86fe9f..5b56610)

| Tarefa | RED (falha pela feature ausente) | GREEN | Logs |
|---|---|---|---|
| T1 preview SQL / ranking por valores | 0/2 (funções inexistentes) | 2/2 | `t1-red.log`, `t1-green*.log` |
| T2 preview HTTP | 0/1 (rota inexistente) | 3/3 | `t2-red.log`, `t2-green.log` |
| T3 finalização atômica | 0/6 | 11/11 | `t3-red.log`, `t3-green*.log` |
| T4 matriz de grants / `MATRIX_EXPECTED` | 0/1 (duas vezes) | 1/1 | `t4-red*.log`, `t4-green*.log` |
| T5 testes antigos no contrato novo | 45 pass / 29 fail | identity-registration 12, identity-http 8, flow-legacy 9, mail 24, protected 2 | `t5-*.log` |
| T6 e2e-v1 | e2e falhou (rota nova ausente → HTML) | e2e rc=0 | `t6-e2e-red.log`, `final-e2e.log`, `../e2e/e2e-v1-result.json` |
| T7 UI `/inscricao` | 0/2 | 2/2 | `t7-ui-red.log`, `t7-ui-green*.log` |

## Correções pós-revisão (review.log de 28/10, passe único; commits 7a8b8fd..9c5e6cb)

| Item | RED | GREEN | Logs |
|---|---|---|---|
| F1 (alta) `(MENTORA)` literal | preview SQL/HTTP devolviam `'Gabi Demo'` (demo_name) onde se espera `'(MENTORA)'` | rótulo `coalesce(nullif(btrim(display_name),''),'(MENTORA)')` | `fix-red-pg.log`, `fix-green-pg-2.log` |
| F2 (média) ordem de locks | T2 com guard tomado + cadastro + `api_admin_domain_update` na mesma mentora → cadastro abortado por deadlock: `[409, RETRY_TRANSACTION]` | protocolo R3 → as duas concluem (202 + edição gravada), cadastro esperou o guard | idem |
| F3 (média) elevação concorrente | `privileged-account grant-admin` (afterLock) da conta de mesmo e-mail → cadastro `202` sem esperar, match em mentora protegida | espera o lock da conta e responde `422 mentor_ref`, nada gravado | idem |
| F3 reconferência do conjunto | conta `team` nova de mesmo e-mail criada com o guard tomado → `202` | `409 RETRY_TRANSACTION` (40001), nada gravado; refeito → `422 mentor_ref` | idem |
| F4 (baixa) UI busy | POST retido por barreira de rota: botões `[false,false]` desabilitados (esperado `[true,true]`) | `disabled={busy}` em "Trocar mentora" e "← Voltar" | `fix-red-ui.log` (erro mascarado pela promessa), `fix-red-ui-2.log`, GREEN na suíte final |
| F5 cobertura | — | `tests/pg/registration-concurrency.test.ts`: duas conexões reais, barreira por `pg_stat_activity` (backend em espera de lock) | — |
| GREEN intermediário | 1ª tentativa com `internal.api_guard()` quebrou o teste de anti-enumeração (revisão do guard mudava no caminho neutro) | guard com `FOR UPDATE` (padrão WP-002), revisão só sobe com escrita real (trigger) | `fix-green-pg.log`, `fix-green-pg-2.log` |
| Ensaio ops 29→30 | `test_schema_upgrade_pg` exigia exatamente 30 migrations no checkout (3 FAIL em `final-ops-pg-python.log`) | filtra até a read-only; 3/3 OK | `fix-ops-schema-upgrade.log` |
| `legacy-packaging` R2 | `spawnSync docker ENOENT` em `final-test-pg.log` | ambiente: Docker CLI instalado; teste passa sem mudança de produto | suíte final |

## Verificação final coordenada (árvore validada; commit final registrado no relatório de entrega)

| Comando | Resultado | Evidência em `logs/` |
|---|---|---|
| `BUILDING=1 DATABASE_URL=…:1/unavailable pnpm build` | exit 0, sem banco | `coordinator-build.log` |
| `pnpm exec tsc --noEmit` | exit 0 | `coordinator-typecheck.log` |
| `TEST_STANDALONE=1 pnpm test:pg` | 190/190, 0 skips | `coordinator-pg.log` |
| `pnpm test:e2e` | exit 0, 31 migrations, crossing→cadastro definitivo→login full→restart; sem email | `coordinator-e2e.log` |
| UI registration (standalone + Chromium) | 6/6, desktop/mobile, texto exato e bloqueio durante envio | `coordinator-ui-registration.log` |
| UI auth/layout/reservation (standalone + Chromium) | 13/13 | `coordinator-ui-regression.log` |
| `python3 -m unittest discover -s tests -v` | 214/214 | `coordinator-python.log` |
| Unitários de senha | 8/8 | `coordinator-password.log` |
| Ops PG Python (usuário postgres, cluster próprio 55439) | 23/23 | `coordinator-ops-python.log` |
| Ops PG TS (usuário postgres, cluster próprio 55439 + MIGRATION_DATABASE_URL) | exit 0 | `coordinator-ops-ts-corrected.log` |

- Tentativa `fix-final-test-pg.log` foi interrompida quando o CLI delegado encerrou; não conta como resultado. Coordenador reexecutou e aguardou toda a suíte.
- `coordinator-ops-ts.log` falhou por ausência de `WP005_PG_DATA` no harness do coordenador; corrigidas as variáveis/usuário (sem editar produto), rerun verde.
- UI RED inicial do coordenador falhou antes da asserção por falta de assets no standalone. Copiados `.next/static` e `public`; segunda tentativa RED atingiu a asserção esperada (texto exato ausente no sucesso). GREEN final 6/6 após incluir `FINAL_CONFIRMATION` também na tela de sucesso.
- Capturas atuais: `coordinator-final-ui/screenshots/` (não são screenshots de produção).
- Revisão independente: `review.log`; itens F1–F5 tratados em passe único; leitura final do diff pelo coordenador, `git diff --check` limpo.
- PR/CI remoto: **PENDENTE** por falta de autenticação GitHub no sandbox. `gh auth status` sem hosts autenticados; `git push --dry-run` recusou por ausência de usuário. Nenhum push/merge/deploy/seal/schema-upgrade realizado.
- `origin/main` reconferida em `59ab4a807da385ff18044108410744ae4cf632e8`; migrations 1–30 preservadas. Contagens da matriz validadas pela suíte PG/preflight.

## Decisões

Ver seção "Decisões" do plano (D1–D7). Adições durante a execução:

- D2 corrigida (pós-revisão): sem `display_name` → apenas `(MENTORA)`, literal do sponsor de 28/10, sem exceção para demo. Em produção as 8 mentoras demo
  (importadas só com `demo_name`) aparecerão como `(MENTORA)` no crossing até a equipe preencher `display_name`.
- D8 Locks do cadastro no protocolo R3: contas de `internal.domain_lock_users('mentor', …)` `FOR NO KEY UPDATE` (ordem de UUID) → guard `FOR UPDATE`
  → reconferência do conjunto (40001 → HTTP 409 `RETRY_TRANSACTION`, sem retry automático, como nas demais rotas v1) → `FOR SHARE` da mentora.
- D9 Guard por `FOR UPDATE` (não `api_guard()`): o caminho neutro de anti-enumeração não escreve nada; o INSERT do perfil sobe a revisão pelo trigger.
- D10 Migration 31 editada no lugar (ainda não publicada nem selada; a cadeia 1–30 segue intocada).
