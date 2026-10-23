# Operação Tech Woman em PostgreSQL — runbook do operador (WP-005)

Este documento descreve o que o pacote `ops/` faz, em que ordem o operador o usa no host e o que **não** é provado
por ele. Tudo aqui foi ensaiado localmente com fakes de host (docker, registry, nginx, systemd, cron) e com
**PostgreSQL 16 real** em cluster descartável; nada foi executado no host OCI, no GitHub nem com dados reais.

## 1. Peças e quem escreve o quê

| Peça | Papel | Escreve estado? |
|---|---|---|
| `ops/deploy.sh` | comando SSH forçado (`TWDEPLOY/2`), chamado só pelo `deploy.yml` | **nunca** grava o marker; imprime atestado |
| `ops/cutover.py` | CLI do operador, único escritor de `/var/lib/tech-woman-cutover/state.json` + `journal.jsonl` | sim (com `flock`, fsync, journal antes do estado) |
| `ops/manifest.py` | identidade do candidato (`seal`, `migrations`, `ops-package`, `release-facts`) | só `candidate.json` no `seal` |
| `ops/verify-image.sh` | verificação read-only da imagem (`--network none`) | não |
| `ops/freeze.py`, `ops/snapshot.py`, `ops/recover.py`, `ops/hostops.py` | bibliotecas do CLI | não |
| `ops/preflight.py` + `ops/sql/preflight.sql` + `ops/sql/agenda-grants-matrix.sql` | preflight T12/T18 | não (cria só a base isolada do PF-RESTORE) |
| `ops/sql/role-limits.sql` | timeouts finitos por role **IN DATABASE** | sim (configuração das 3 roles na base techwoman) |
| `ops/nginx/*.conf` | redação de tokens só no vhost Tech Woman | — |
| `ops/paths.env` | caminhos e nomes fixos do host (parte do pacote hasheado) | — |

Nenhuma variável de ambiente nem argumento muda caminhos privilegiados: eles vêm de `paths.env`, que está dentro do
hash do pacote (`ops_package`). Alterar qualquer arquivo de `ops/` muda o hash e exige novo `seal`.

## 2. Instalação (OPS-001, antes do merge)

1. Copiar `ops/` inteiro para `/usr/local/lib/tech-woman` (`root:root`, diretórios `0755`, `*.sh` `0755`, demais `0644`),
   sem arquivo a mais ou a menos. Conferir:
   `python3 /usr/local/lib/tech-woman/manifest.py ops-package-sha /usr/local/lib/tech-woman` == `ops_package` do candidato.
2. Chave SSH do GitHub com `command="/usr/local/lib/tech-woman/deploy.sh",restrict,no-pty`.
3. `/var/lib/tech-woman-cutover` `root:root 0700`; `candidate.json` `0644`.
4. Env files separados em `TW_ENV_DIR`: `web.env` (sem `MIGRATION_DATABASE_URL`/`MAILER_DATABASE_URL`), `mailer.env`
   (sem `MIGRATION_DATABASE_URL`), `migrator.env`. Só os **nomes** de variáveis são conferidos; valores nunca são lidos.
5. Confirmar/ajustar em `paths.env` (valores ainda presumidos): `TW_PG_CONTAINER`, `TW_PG_DB`, `TW_PG_DUMP_USER`,
   `TW_PG_ADMIN_USER`, `TW_CRON_PATHS`. Qualquer ajuste exige novo `seal`.

### Roles do PostgreSQL que o operador cria/ajusta
- **Backup só-leitura (`TW_PG_DUMP_USER` = `backup_techwoman`)**: `CREATE ROLE backup_techwoman LOGIN BYPASSRLS;`
  `GRANT pg_read_all_data TO backup_techwoman;`. **BYPASSRLS é obrigatório**: as tabelas de Agenda têm RLS e o
  `pg_dump` de uma role sem BYPASSRLS falha (`query would be affected by row-level security policy`); o `deploy.sh`
  então sai 79 sem tocar em contêiner (provado no ensaio S14). O nome **não** pode começar com `techwoman_`: a matriz
  WP-003 (`PF-COLGRANT`) proíbe BYPASSRLS em qualquer role `techwoman_*` — provado em PG16 que `backup_techwoman`
  convive com o preflight verde e faz o dump.
- **Limites**: `docker exec -i <pg> psql -X -v ON_ERROR_STOP=1 -U <admin> -d techwoman -f - < ops/sql/role-limits.sql`
  (padrões: runtime/mailer lock 5s, statement 15s, idle-tx 10s; editora 10s/60s/30s; sobrescreva com
  `-v runtime_lock=...` etc.). Só `ALTER ROLE ... IN DATABASE techwoman`: bases vizinhas não mudam. Vale para
  **novas** sessões de login — reinicie os pools do web/mailer depois. Valor zero, negativo, > 1h ou não-intervalo
  aborta sem mudar nada.
- **USAGE em `public`**: o preflight exige que `PUBLIC` não tenha USAGE/CREATE em `public`, `internal` e
  `legacy_snapshot`. Com o bootstrap de produção, owner e editora dependem de PUBLIC; a remediação **provada** (matriz
  581/18/46 verde depois dela) é:
  `REVOKE USAGE ON SCHEMA public FROM PUBLIC; GRANT USAGE ON SCHEMA public TO techwoman_runtime, techwoman_mailer,
  techwoman_migrator, techwoman_owner, techwoman_beatriz;` — revogar sem os GRANTs quebra `internal.validate_agenda_state`.
- **Outras bases**: `REVOKE CONNECT ON DATABASE <outra> FROM PUBLIC` onde as roles do Tech Woman não devem entrar
  (o preflight conta, sem imprimir nomes).
- **pg_hba**: a primeira regra TCP que alcança runtime/mailer/editora na base techwoman deve ser `scram-sha-256` (ou `cert`).

## 3. Fases e transições (`state.json`)

`prepared → frozen → snapshotted → imported → activated → smoke_ok → pg_write_open`; `frozen|snapshotted|imported →
aborted_pre_write`; `activated|smoke_ok|pg_write_open → recovering`; `recovering → pg_write_open` (recuperação provada);
`prepared → prepared` (registro do stage) e `pg_write_open → pg_write_open` (release, rebind, primeiro write).
Qualquer outra transição sai 75. **Nenhuma** transição volta de uma fase pós-ativação para o SQLite.

## 4. Runbook do corte (sempre no host, nunca pelo CI)

| # | Comando | Pré-condição | Efeito |
|---|---|---|---|
| 1 | `python3 ops/manifest.py seal --facts F --migrations-dir drizzle --ops-dir /usr/local/lib/tech-woman --out /var/lib/tech-woman-cutover/candidate.json` | CI verde no head/tree testados, GATE-001..003, janela medida, `decision_ref`, hash da evidência de recuperação, RPO | candidato selado |
| 2 | `cutover.py prepare` | candidato == instalação, janela vigente | marker `prepared` |
| 3 | (GitHub) merge → `deploy.yml` → `deploy.sh` **stage** | probe v2 + pacote igual | pull+verify, atestado no summary; nada ativado |
| 4 | `cutover.py register-stage < atestado.json` | reverifica a imagem localmente | `staged` gravado |
| 5 | escrever `/var/lib/tech-woman-cutover/writers-inventory.json` (root, não gravável por outros) | inventário **fechado** | — |
| 6 | `cutover.py freeze --quiet-seconds N` | inventário do candidato, `complete: true`, contêiner `tech-woman` listado | manutenção 503 no lugar, escritores conferidos, janela quieta, SQLite `chmod a-w` (+`chattr +i`) |
| 7 | `cutover.py snapshot` | ninguém segura o arquivo e o hash do SQLite == o do freeze | cópias A e B (Backup API) iguais em `private/` 0600 |
| 8 | `cutover.py import-verify` | relatório do importador real limpo duas vezes, mesmo `runId` | `imported` (ou abort pré-write, SQLite restaurado) |
| 9 | `cutover.py activate` | janela | migrador + web PG ao lado da página 503 |
| 10 | `cutover.py smoke` | — | GET interno read-only |
| 11 | `cutover.py open-writes` | janela | baseline, tráfego no web PG (mesmo IP/alias), mailer depois |
| 12 | `cutover.py record-first-write` | — | tipo+hora do 1º write auditado acima do baseline (sem PII) |
| 13 | release de código: novo `seal` (mesmo schema) → `cutover.py rebind` → (GitHub) `deploy.sh` **release** → `cutover.py register-release < atestado.json` | schema igual, imagem atestada | backup `pg_dump` antes de qualquer efeito; troca no lugar; rollback só para `last_good_pg_image` |

Inventário de escritores (passo 5), formato fechado (campo a mais/menos = 64):
```json
{"schema":1,"candidate_sha256":"<sha256 do candidate.json>","complete":true,"decision_ref":"dec-...",
 "writers":[{"id":"tech-woman","kind":"container"},{"id":"tech-woman-mailer","kind":"container"},
            {"id":"tech-woman-backup.service","kind":"systemd-unit"},{"id":"root-crontab-sync","kind":"cron"},
            {"id":"pgadmin-operator-session","kind":"external"}]}
```
`container` e `systemd-unit` são verificados no host (`docker ps`, `systemctl is-active`); `cron`, `process` e
`external` só podem ser **atestados** pelo operador e ficam registrados em `freeze.attested_only`. Root sempre pode
escrever no arquivo: `chmod a-w`/`chattr +i` barram escritores acidentais e a revalidação antes do snapshot detecta
qualquer escrita depois do freeze (80) — não é garantia contra root.

## 5. Códigos de saída

| Código | Significado | Efeito garantido |
|---|---|---|
| 64 | entrada/protocolo/argumento inválido (inclui injeção, traversal, nome de dump) | nenhum |
| 65 | `deploy.sh`/pacote instalado ≠ candidato | nenhum |
| 66 | outra operação em curso (`flock`) | nenhum |
| 70 | marker/candidato/inventário ausente, ilegível, mal-possuído ou inconsistente | nenhum |
| 71 | árvore do release ≠ árvore testada | nenhum |
| 72 | migrations divergem do candidato / schema mudou desde o corte | nenhum |
| 73 | fora da janela autorizada | nenhum |
| 74 | imagem inválida (arch, label, entrypoints, env files) ou registry | nenhum |
| 75 | fase não permite o comando | nenhum |
| 76 | web em execução não é imagem PG conhecida (ex.: SQLite) | nunca é reiniciada nem renomeada |
| 77 | migração/smoke falhou; recuperação PG-compatível aplicada (`last_good`) ou manutenção mantida | nunca SQLite |
| 78 | evidência de recuperação ausente no `seal` | nenhum |
| 79 | backup `pg_dump` pré-release falhou | nada parado/renomeado |
| 80 | escritor presente / inventário incompleto / SQLite mudou desde o freeze | serviço original restaurado |
| 81 | snapshot A≠B ou integridade/FK | fase continua `frozen` |
| 82 | import-verify falhou | abort pré-write, SQLite restaurado |
| 83 | comando do host falhou | serviço original restaurado (ou 84) |
| 84 | **restauração falhou**: original guardado como `tech-woman-sqlite-original`; ação manual | nunca alegado como disponível |
| 85 | PostgreSQL vivo ilegível: nada restaurado, RPO declarado, decisão do operador exigida | fase `recovering` (deploys negados) |
| 86 | cópia restaurada ≠ base viva (ou dados comprometidos ausentes) | nada aceito |
| 87/88 | preflight: alguma falha / algo pendente | — |

## 6. Recuperação pós-write (C7, implementada no S10)

- **R-A — restart (PG íntegro):** `cutover.py recover --mode restart`. Lê a base viva (READ ONLY): contagens ≥ baseline,
  existência do 1º write auditado e nenhuma sequence atrás do `max(id)`; só então `docker start` do web (se a imagem
  ∈ `known_pg_images`, senão 76) e do mailer, smoke interno. Provado em PG16: reserva commitada sobrevive a
  `pg_terminate_backend` + `pg_ctl restart -m immediate` com match/email_job/audit; transação em voo some; próximo
  id > anterior.
- **R-B — restore isolado + confronto completo:** em vez de reaplicar “delta” parcial,
  `cutover.py recover --mode reconcile` faz **agora** um `pg_dump -Fc` completo da base íntegra
  (`TW_BACKUP_DIR/recovery-<seq>-<ts>.dump`, 0600), restaura numa base **nova** `<db>_restore_<ts>_<seq>` e confronta
  linha a linha (todas as tabelas de todos os schemas, chave primária + hash da linha inteira, sequences e o schema
  sem comentários). Só com igualdade total a fase volta a `pg_write_open` com `recovery{dump_sha256, restored_db, ...}`.
  Qualquer escrita entre o dump e o confronto dá 86 (rodar em manutenção).
- **Dump antigo (diário) ≠ perda zero:** `cutover.py recover --mode compare --dump <nome.dump>` restaura o dump dado
  em base isolada e relata por tabela `only_live / only_restored / changed` (só nomes e contagens). Provado: a reserva
  feita depois do dump não existe na cópia e o cancelamento posterior (UPDATE sem id novo) aparece como `changed`.
- **Sem base viva legível:** 85 com o RPO declarado no candidato e o dump mais novo; nada é restaurado e nenhum sucesso
  é alegado — restaurar um dump antigo é decisão explícita do operador (`decision_ref`).
- Limite: o confronto de schema ignora parênteses porque dump/restore achata `AND` aninhados em CHECKs; prova que todo
  objeto voltou, não que expressões estão escritas igual. Bases isoladas ficam para inspeção; o operador as remove.

## 7. Preflight (C8, S12)

`python3 /usr/local/lib/tech-woman/preflight.py run [--restore-dump <nome.dump>]` — saída JSON
`{candidate_sha256, overall, checks[{id,status,detail}]}`; exit 0/87/88.

- **SQL (T12)**: `PF-ROLE-FLAGS`, `PF-ROLE-MEMBER`, `PF-PUBLIC-SCHEMA`, `PF-PUBLIC-FUNC`, `PF-DEFPRIV`, `PF-ROLE-LIMITS`,
  `PF-OTHER-DB`, `PF-HBA` (uma consulta READ ONLY) e `PF-COLGRANT` (a matriz do WP-003, cópia byte-idêntica, exige
  exatamente 581 negações / 18 permitidas / 46 verificações; ela roda numa transação que desfaz as fixtures). Base
  ilegível ⇒ todos **fail**.
- **Host (T18)**: `PF-PG-PORT`, `PF-PGADMIN-TLS/-COOKIE/-RATE/-CONN`, `PF-BACKUP-DAILY`, `PF-NGINX-REDACT`,
  `PF-NO-SHARED-TOUCH` ficam **pending** até o operador registrar readback em
  `/var/lib/tech-woman-cutover/host-evidence.json` (root, não gravável por outros):
  `{"schema":1,"candidate_sha256":"…","items":{"PF-PG-PORT":{"collected_at":"<UTC Z>","files":{"ss-ltn.txt":"<sha256>"}}}}`
  com os arquivos em `/var/lib/tech-woman-cutover/evidence/`. O preflight recalcula cada hash, recusa candidato diferente
  (fail), evidência com mais de 7 dias ou datada no futuro (pending), e julga o **conteúdo**:

| Item | Arquivo(s) e como coletar | Regra |
|---|---|---|
| PF-PG-PORT | `ss-ltn.txt` = `ss -ltnH` | nenhum `:5432` fora de loopback |
| PF-PGADMIN-TLS / -COOKIE | `pgadmin-headers.txt` = `curl -sSI https://<pgadmin>/login` | 2xx/3xx com HSTS; todo `Set-Cookie` com `Secure` e `HttpOnly` |
| PF-PGADMIN-RATE | `pgadmin-burst.txt` = um status HTTP por linha de ≥20 tentativas | contém 429 |
| PF-PGADMIN-CONN | `pgadmin-servers.json` = `setup.py dump-servers` (sem senha) | nenhum `Username: postgres`, nenhuma senha salva |
| PF-BACKUP-DAILY | `backup-listing.txt` = `find <dir> -maxdepth 1 -name '*.dump' -printf '%T@ %s %f\n'`; `backup-toc.txt` = `pg_restore -l <mais novo>` | ≥7 dumps, mais novo >0 B e ≤26 h na coleta, `dbname: techwoman` |
| PF-NGINX-REDACT | `nginx-T.txt` = `nginx -T`; `nginx-readback.txt` = linhas do log após `GET /api/state/twprobe0000000000000000000000000000000000000` | `tw_redacted` + include no vhost; log com `/api/state/[redacted]` e sem o token |
| PF-NO-SHARED-TOUCH | `shared-before.txt`/`shared-after.txt` = `sha256sum` das configs alheias antes/depois | idênticos e não vazios |
| PF-RESTORE | `--restore-dump <nome>` | restaura em base nova `<db>_preflight_<ts>`, tabelas/linhas > 0, schema igual ao vivo |

Nenhum SQL, comando ou caminho livre é aceito (só o nome simples de um `.dump`); relatórios não trazem conteúdo de
evidência, nomes de bases alheias, caminhos ou segredos.

## 8. nginx (S13)

Instalar `tech-woman-redact-http.conf` em `conf.d/` e incluir `tech-woman-redact-server.conf` **dentro** do `server`
de `tech-woman.dellanio.com`. `nginx -t` antes; **reload**, nunca restart do nginx compartilhado; readback com o token
sintético acima. `error_log ... crit` e `/dev/null` nas rotas sensíveis são limitação documentada.

## 9. Testes e comandos reais

- `python3 -m unittest discover -s tests -v` (hermético; Windows e Linux).
- PostgreSQL 16 próprio e descartável: `WP005_PG_DATA=<dir> WP005_PG_PORT=55346 [PG_BIN=...] python3 -m unittest -v
  tests.ops.pg.test_recovery_pg tests.ops.pg.test_preflight_pg tests.ops.pg.test_rehearsal_pg` e
  `pnpm exec tsx --test --test-concurrency=1 tests/ops/pg/*.test.ts` (com `MIGRATION_DATABASE_URL` para o contrato do
  importador). Sem os pré-requisitos os testes **falham** pedindo-os (não há skip).
- `tests/ops/pg/test_rehearsal_pg.py` é o ensaio ponta a ponta (SQLite → importador real → PG16 → release com
  `pg_dump` real → compare).

## 10. O que NÃO está provado (declarado)

Build/run ARM da imagem; CI remoto (o job `check` não rodou; `pnpm test:e2e` aponta para `tests/pg/legacy-e2e.ts`,
obsoleto frente à API 202 — pedido INT-005 R-008, o passo fica vermelho até a integração); host OCI, pgAdmin, nginx
real, backup diário real, troca de tráfego pelo alias `app` no nginx compartilhado; importador contra o SQLite de
produção; caminho positivo real da Beatriz. Preflight de host só passa com evidência real coletada pelo operador.
