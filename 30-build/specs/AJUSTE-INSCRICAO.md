# AJUSTE-INSCRICAO — crossing antes das credenciais, senha definitiva no cadastro (t_e5584a38)

> Plano de implementação (formato writing-plans). Base exclusiva: `59ab4a8` (origin/main, 30 migrations). Branch `feat/inscricao-senha-crossing`.
> Pedido: `30-build/specs/PEDIDO-SPONSOR-20261028-inscricao-senha-crossing.md`. Progresso/evidências: `30-build/planos/WP-INSCRICAO.md`.
> Evidência durável: `/fabrica/tech-woman/40-verificacao/t_e5584a38/`.

## Goal

A participante faz o diagnóstico, vê o **crossing** (só o nome das mentoras compatíveis, ordenadas pelo ranking existente, com troca livre),
e só então informa **e-mail + senha definitiva + confirmação** (última etapa). A finalização cria, numa única transação SQL, a conta
`active` com `password_hash`, o perfil de participante e o match escolhido — sem senha temporária e sem e-mail no caminho normal.
Texto final exato: **"O cadastro da participante na plataforma criará o seu cadastro no sistema, além de já dar carga no cruzamento escolhido por ela."**

## Architecture

```
/inscricao (client)                       Next route handlers (runtime)                    PostgreSQL 16 (owner NOLOGIN, SECURITY DEFINER)
 01 trajetória ─┐
 02 interesses ─┤ POST /api/v1/registrations/participants/preview ──► internal.registration_preview(goal,moment,interests,skills,area)
 03 crossing  ◄─┘   origem → readJson 64 KiB → DTO fechado → rate IP      └─ internal.registration_candidates(...) (STABLE, sem escrita)
                    ◄── [{mentor_ref, nome_exibicao}] (ref = HMAC(id))         └─ internal.agenda_ranking_values(...) ◄─ agenda_ranking(p,m) delega
 04 e-mail+senha+confirmação
    POST /api/v1/registrations/participants (Idempotency-Key)
      origem → readJson → DTO fechado (senha 12..128, confirmação igual, mentor_ref) → chave → rate e-mail/IP
      → hashPassword (scrypt existente, fora da transação)
      → BEGIN; idem_begin(fingerprint sem senha crua); candidates → ref→id; register_participant_account(email,hash,perfil,mentor); idem_finish; COMMIT
 05 confirmação neutra (202 {status:'received', next:'login'})
```

- **Preview sem persistência**: função `STABLE SECURITY DEFINER` que só lê `mentor` e calcula o ranking por valores (nenhum perfil temporário).
- **Referência opaca**: `mentor` não tem UUID; `mentor_ref = base64url(HMAC-SHA256(chave derivada de SESSION_SECRET, "tw:mentor-ref:v1:" + id))`.
  O banco nunca vê o segredo; o servidor resolve a ref recalculando as candidatas compatíveis do mesmo diagnóstico (ref fora da lista → 422 `mentor_ref`).
- **Compatível** = mentora `active`, não protegida (`internal.domain_protected`) e score do ranking existente `> 0`. Independe de turma/capacidade.
  Ordem = `score DESC, id ASC` (a mesma de `api_recommendations`). Nome = `display_name` → (`demo_name` se demo) → `(MENTORA)`.
- **Finalização**: `internal.register_participant_account` muda de assinatura (DROP explícito + CREATE). Trava a linha da mentora
  (`FOR SHARE`: bloqueia desativação/troca de especialidades concorrente até o commit) e revalida a compatibilidade **antes** de olhar o
  e-mail (erro de mentora não depende do e-mail → sem enumeração).
  Depois aplica os mesmos predicados anti-enumeração de hoje (legado sem vínculo, chaves privilegiadas, e-mail existente) → `false` sem mutação.
  Cria `app_user(status 'active', password_hash)`, `user_role participant`, `participant` (consent v1) e `match(status 'suggested', origin 'current')`
  com score/razões do ranking, e auditoria `match.create`. **Nenhum `email_job`.** Qualquer falha = exceção = rollback total.
- **Idempotência**: corpo canônico com a senha substituída por `passwordFingerprint = HMAC(chave derivada, senha)` (estável no replay, sem
  senha crua, sem duplo hash scrypt); `passwordConfirmation` fica fora (já validada igual).
- **Sem bypass**: o adapter antigo `/api/participant` passa a exigir o mesmo DTO novo (corpo antigo → 400 sem mutação); a assinatura SQL antiga deixa de existir.

## Tech Stack

Next 15 (route handlers `runtime='nodejs'`), React 19 client components, drizzle `sql` + `pg`, PostgreSQL 16 (plpgsql), `node:test` via `tsx --test`,
Playwright Chromium (UI), Python `unittest` (ops/CI). Hash de senha: `hashPassword`/`verifyPassword` (scrypt) de `src/lib/db.ts`.

## Spec (aceites do card)

1. Ordem pública: diagnóstico (etapas 01/02 atuais) → crossing (03) → e-mail+senha+confirmação (04, última) → confirmação (05).
   Crossing só nome/(MENTORA) + ref opaca; troca entre todas as compatíveis; sem datas/horários; sem compatíveis → explica e permite editar respostas.
2. Preview: sem e-mail/credenciais/consentimento; não persiste `app_user`/`participant`/`match`; devolve só `[{mentor_ref, nome_exibicao}]`;
   rate por IP (`enforceRate`), `readJson` 64 KiB, origem verificada; reusa o ranking; ref não sequencial e validada no servidor.
3. Finalização: diagnóstico + `mentor_ref` + e-mail + senha + confirmação; SQL SECURITY DEFINER único; conta active com hash; sem temporária;
   match escolhido revalidado; rollback total; anti-enumeração/limites/idempotência preservados; nada de senha crua no hash canônico; sem e-mail.
4. Texto final exato (acima).
5. Migration 31 append-only; grants/ownership NOLOGIN; matriz idêntica nas duas cópias; `MATRIX_EXPECTED`; DROP FUNCTION explícito;
   admin create/resend/recuperação intocados; e2e-v1 prova cadastro definitivo → login full → restart.
6. TDD RED→GREEN em PG16 real; evidência durável.

## Global Constraints

- Não editar migrations 1–30 nem SQL dos fluxos admin/resend/recuperação (`admin_user_*`, `enqueue_admin_temporary`, `request_password_forgot`,
  `issue_*`, `consume_reset_token`, worker). Não enfraquecer asserts de admin/recovery.
- Sem `any`, `@ts-ignore`, `skip`/`todo` para passar. Fixtures determinísticas e sintéticas (`example.invalid`).
- Preservar UI Recife/tokens (`globals.css`, classes existentes `progress-head`, `wizard-grid`, `form-panel`, `choices`, `success-panel`…).
- Sem push/PR/merge/deploy/seal/schema-upgrade. Commits pequenos convencionais com `git add` de arquivos explícitos.
- PG local próprio: `.local-pg` porta 55438, `MIGRATION_DATABASE_URL` com host `127.0.0.1`.

## Review Focus

- Atomicidade e ordem dos checks em `register_participant_account` (mentora antes do e-mail; falha → nada gravado).
- Nenhuma senha crua em `api_idempotency`, logs, respostas; hash scrypt calculado uma vez, fora da transação.
- Preview realmente sem escrita (snapshot completo antes/depois) e sem vazar id/e-mail/score/razões.
- Ref opaca: não decodificável, estável entre processos com o mesmo segredo, rejeitada se fora das compatíveis do diagnóstico enviado.
- UI: requisições fora de ordem ignoradas, troca de mentora, volta/edição, senha divergente, estado sem compatíveis.

## Decisões (registradas também no ledger)

- D1 `mentor_ref` por HMAC (sem coluna nova): evita migration de dados e mantém o id fora do cliente.
- D2 Nome: `display_name` → `demo_name` (só demo, como a projeção pública existente) → `(MENTORA)` (pedido 28/10).
- D3 Match do cadastro = `status 'suggested', origin 'current'`, sem `enrollment_id` (mesma forma do match criado pelo admin;
  `selected` é reservado a match ligado a reserva). A agenda/turma entra depois.
- D4 Resposta neutra nova `{status:'received', next:'login'}` (conta nova ou e-mail indisponível são indistinguíveis; sem auto-login).
- D5 Rate do preview: balde por IP `registration-preview-ip`, `RATE_PREVIEW_IP_PER_HOUR` (padrão 60/h — a usuária pode voltar e editar).
- D6 `agenda_ranking(p,m)` passa a delegar a `agenda_ranking_values(...)` (mesmo corpo/semântica): uma única implementação do ranking.
- D7 Contas `pending_activation` antigas (antes da 31) continuam válidas: worker/forgot/admin intocados; testes que precisam desse estado usam
  fixture SQL do dono que reproduz exatamente o que o cadastro antigo gravava.

---

## Task 0 — Ambiente e linha de base

- [ ] PG16 servidor via apt (sem serviço), cluster `.local-pg/data`, porta 55438, superusuária sintética `twlocal`, só `127.0.0.1`.
- [ ] `pnpm build` e `TEST_STANDALONE=1 pnpm test:pg` na base, logs em `40-verificacao/t_e5584a38/logs/baseline-*`.

## Task 1 — Ranking por valores + preview SQL sem persistência (migration 31, parte 1)

**Arquivos**: `drizzle/20261028120000_inscricao_crossing.sql` (novo), `drizzle/meta/_journal.json`, `drizzle/meta/20261028120000_snapshot.json`,
`tests/pg/registration-crossing.test.ts` (novo).

**Interfaces SQL**
```sql
internal.agenda_ranking_values(p_goal text, p_interests jsonb, p_skills jsonb, p_area text, p_mentor bigint, OUT o_score integer, OUT o_reasons jsonb) -- STABLE, owner
internal.agenda_ranking(p_participant bigint, p_mentor bigint, OUT ...) -- CREATE OR REPLACE, delega (mesma ACL/owner)
internal.registration_candidates(p_goal text, p_interests jsonb, p_skills jsonb, p_area text) RETURNS TABLE(mentor_id bigint, score integer, reasons jsonb, label text) -- STABLE, owner
internal.registration_preview(p_goal text, p_moment text, p_interests jsonb, p_skills jsonb, p_area text) RETURNS jsonb -- SECURITY DEFINER STABLE, runtime EXECUTE
```
- [ ] RED: teste PG chama `internal.registration_preview` (função inexistente → falha), espera ordem por ranking, `(MENTORA)`, demo_name,
      mentora sem turma incluída, inativa/score 0/protegida excluída, snapshot do banco idêntico, `agenda_ranking_values` = `agenda_ranking`.
- [ ] GREEN: migration com as funções, owner `techwoman_owner`, `REVOKE ALL FROM PUBLIC`, `GRANT EXECUTE` só do preview ao runtime.
- [ ] Verificar: `tsx --test tests/pg/registration-crossing.test.ts`. Commit `feat(db): preview de crossing por valores sem persistência`.

## Task 2 — Preview HTTP (rota pública)

**Arquivos**: `src/lib/contracts.ts` (`parseRegistrationPreview`, tipo `CrossingChoice`), `src/lib/crossing.ts` (novo: `mentorRef`, `previewCrossing`),
`src/lib/auth.ts` (`previewRules`), `src/app/api/v1/registrations/participants/preview/route.ts` (novo).

```ts
export type CrossingChoice = { mentor_ref: string; nome_exibicao: string };
export function parseRegistrationPreview(value: unknown): Omit<ParticipantFields,'consent'>;
export const mentorRef: (id: string) => string;            // HMAC base64url 43
export async function previewCrossing(input: unknown): Promise<CrossingChoice[]>;
export const previewRules: (request: Request) => RateRule[]; // IP, RATE_PREVIEW_IP_PER_HOUR (60)
```
- [ ] RED: teste HTTP chama a rota (módulo inexistente → falha): 200 só com chaves `mentor_ref,nome_exibicao`; ref ≠ id, estável, 43 chars;
      origem ausente/cruzada 403; `text/plain` 400; corpo > 64 KiB 400; email/password/consent no corpo 422; limite por IP 429 com Retry-After;
      nenhuma linha gravada além do balde de rate.
- [ ] GREEN: implementação. Verificar e commit `feat(api): preview público do crossing`.

## Task 3 — Finalização transacional (SQL + serviço + rota)

**Arquivos**: migration 31 (parte 2), `src/lib/contracts.ts` (`parseParticipantSignup`, `participantSignupReceived`), `src/lib/registration.ts`
(`registerParticipant` novo, fingerprint), `src/lib/crossing.ts` (`resolveMentorRef`), rota `src/app/api/v1/registrations/participants/route.ts`,
adapter `src/app/api/participant/route.ts`.

```sql
DROP FUNCTION internal.register_participant_account(text,text,text,jsonb,jsonb,text);
CREATE FUNCTION internal.register_participant_account(p_email text, p_password_hash text, p_goal text, p_moment text, p_interests jsonb,
  p_skills jsonb, p_area text, p_mentor bigint) RETURNS boolean -- SECURITY DEFINER, owner NOLOGIN, runtime EXECUTE
GRANT INSERT (password_hash) ON public.app_user TO techwoman_owner;
```
```ts
export type ParticipantSignup = ParticipantRegistration & { password: string; passwordConfirmation: string; mentor_ref: string };
export type ParticipantSignupReceived = { status: 'received'; next: 'login' };
export async function registerParticipant(input: unknown, idem?: PublicIdempotency): Promise<ParticipantSignupReceived>;
```
- [ ] RED (cada item é um teste): conta active + hash verificável + sem temporária/must_change + perfil + match suggested/current com score do ranking
      + nenhum `email_job` + `identity.login` → `authenticated`; ref inválida/forjada → 422 sem mutação; mentora desativada/especialidade alterada
      entre preview e finalização → 422 sem mutação; falha injetada no INSERT do match (trigger de teste) → nada gravado; e-mail existente
      (ativa/pendente/desativada/admin), legado sem vínculo, chave privilegiada → 202 idêntico sem mutação e hash antigo intacto;
      senha curta / confirmação divergente → 422; idempotência: replay 202 sem duplicar, senha diferente com a mesma chave 409, `request_hash` ≠
      hash do corpo com senha crua e dump de `api_idempotency` sem senha; corpo antigo (sem senha/ref) → 422 (v1) e 400 (adapter antigo).
- [ ] GREEN: SQL + serviço + rotas. Commit `feat(cadastro): finalização atômica com senha definitiva e crossing`.

## Task 4 — Grants, matriz e owner

**Arquivos**: `scripts/migration/agenda-grants-matrix.sql` e `ops/sql/agenda-grants-matrix.sql` (byte idênticos), `ops/preflight.py`
(`MATRIX_EXPECTED`), `tests/ops/test_preflight.py`, `tests/ops/pg/test_preflight_pg.py`, `tests/pg/agenda-grants-matrix.test.ts`.
- [ ] RED: matriz atual roda contra a 31 e conta diferente / teste de fronteira exige `registration_preview` na lista do runtime.
- [ ] GREEN: `registration_preview` na lista autorizada do runtime + `matrix_reaches` do preview e do cadastro novo; medir contagens no PG16 e
      atualizar `MATRIX_EXPECTED` e asserts. `cmp` das duas cópias.

## Task 5 — Atualizar testes antigos ao contrato novo (sem enfraquecer admin/recovery)

**Arquivos**: `tests/pg/pending-participant.ts` (novo, fixture do estado legado), `identity-registration`, `identity-http`, `identity-http-flow`,
`identity-legacy`, `registration-protected-keys`, `legacy-http`, `email-worker`, `email-transport`, `definer-owner-upgrade`, `legacy-packaging`,
`tests/e2e/ui-harness.ts` (`temporaryPassword` via fixture), `tests/test_e2e_target.py`.
- [ ] Cada arquivo: rodar, ver falha pelo contrato novo, ajustar fixture/expectativa mantendo o que o teste protege. Commit `test: ...`.

## Task 6 — e2e-v1: cadastro definitivo → login full → restart

**Arquivo**: `tests/pg/e2e-v1.ts`.
- [ ] RED: novo fluxo (preview → cadastro com senha → login `authenticated` → restart → sessão e senha preservadas, fila vazia, nenhum job do cadastro).
- [ ] Cobertura do entrypoint real do mailer mantida com job de fixture (conta pendente legada), sem depender do prazo de mentoras.

## Task 7 — UI `/inscricao`

**Arquivos**: `src/app/inscricao/signup.tsx`, `src/app/inscricao/crossing.tsx` (novo), `src/app/globals.css` (só se faltar estilo, com tokens
existentes), `tests/e2e/ui-registration.test.ts`.
- [ ] RED (Playwright, PG real): ordem 01→02→03 crossing→04 credenciais→05; crossing só nomes, `(MENTORA)`, troca de mentora, sem datas;
      sem compatíveis → explicação + editar respostas, sem avançar; voltar/editar refaz o preview e descarta escolha incompatível; resposta
      atrasada de preview antigo é ignorada; senha divergente bloqueia; texto final exato; corpo enviado sem senha no preview; 202 neutro;
      duplicata indistinguível; conta autenticada continua anexando perfil sem e-mail/senha.
- [ ] GREEN + screenshots desktop/mobile (Playwright do clone) em `40-verificacao/t_e5584a38/screenshots`.

## Task 8 — Verificação final

- [ ] `pnpm exec tsc --noEmit`, `pnpm build` (sem banco), `TEST_STANDALONE=1 pnpm test:pg`, `pnpm test:e2e`, suítes UI afetadas,
      `python3 -m unittest discover -s tests -v`, `tests/unit/password.test.ts`, suites ops PG (`tests/ops/pg`) com o PG16 local.
- [ ] Revisar `git diff 59ab4a8..HEAD`, registrar comandos/resultados no ledger e em `40-verificacao/t_e5584a38`.
