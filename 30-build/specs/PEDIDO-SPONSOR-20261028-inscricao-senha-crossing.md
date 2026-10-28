# AJUSTE — Inscrição: crossing antes das credenciais, senha definitiva no cadastro

<!-- Pedido do sponsor (27–28/10/2026, conversa Hermes Desktop). Decisões literais abaixo. -->

## Pedido do sponsor
1. No momento da inscrição, a participante define e confirma a **senha definitiva**. Sem senha temporária por e-mail.
2. **E-mail e senha são a última etapa** do cadastro.
3. Antes das credenciais, o **cruzamento (crossing)** é exibido com resultados calculados a partir das escolhas.
4. Nesta fase o crossing mostra **apenas o nome da mentora** compatível e permite **trocar** para outra mentora compatível. Datas/horários entram depois (agenda por mentora, Beatriz).
5. Confirmação final, texto exato:
   > O cadastro da participante na plataforma criará o seu cadastro no sistema, além de já dar carga no cruzamento escolhido por ela.
6. Decisões de 28/10:
   - Mentora sem `display_name` → exibir apenas **(MENTORA)**.
   - O preview **mostra mentoras compatíveis mesmo sem turma aberta**.

## Desenho técnico (operador, a partir da main 59ab4a8 — já em produção, 30 migrations)
- Fase 1 — **preview público sem persistência**: endpoint que recebe as escolhas e devolve só `[{mentor_ref, nome_exibicao}]` das compatíveis (todas, ordenadas pelo ranking existente). Não cria `app_user`, `participant` nem `match`. Rate limit por IP como as rotas públicas (`hourlyRules`/`enforceRate`), `readJson()` 64 KiB, origem verificada. Não expor nada além do nome/(MENTORA) e de uma referência opaca.
- Fase 2 — **finalização transacional**: escolhas + mentora escolhida + e-mail + senha (+ confirmação) → numa única transação SQL (função `internal.*` SECURITY DEFINER) cria conta (`password_hash` com o hash existente, sem `temporary_password_hash`/`must_change_password`), perfil e o match escolhido (revalidando a compatibilidade no servidor). Falha em qualquer parte = nada gravado.
- Caminho normal **não aciona o worker de e-mail**.
- Preservar anti-enumeração (e-mail já cadastrado, cadastro antigo não vinculado, e-mail administrativo → resposta indistinguível) e os rate limits.
- Fluxos admin create/resend e recuperação de senha continuam como estão.
- Mudança de assinatura de função SQL: `DROP FUNCTION` + atualizar as cópias idênticas `ops/sql/agenda-grants-matrix.sql` e `scripts/migration/agenda-grants-matrix.sql` + `MATRIX_EXPECTED`. Migration nova append-only (31ª), grants runtime junto.
- Produção hoje: 10 mentoras (8 demo com nome, 2 reais sem nome), 0 turmas, 0 temas → testes com fixtures determinísticas.

## Regras
- TDD: RED antes do código (preview sem persistência, transação atômica, senha só hash, sem e-mail, anti-enumeração, (MENTORA), preview sem turma aberta).
- Nada de deploy/seal/schema-upgrade neste card. O release será um DEPLOY-003 separado (migration 31 exige `schema-upgrade`).
