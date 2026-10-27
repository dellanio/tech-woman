-- WP-003: matriz EXECUTÁVEL de privilégios efetivos de Agenda/identidade (afirmações positivas e negações realmente executadas).
-- Uso (operador/OPS, depois das migrations): psql -v ON_ERROR_STOP=1 -X -f scripts/migration/agenda-grants-matrix.sql "<conexão administrativa da base techwoman>"
-- A conexão precisa poder SET ROLE para techwoman_beatriz/techwoman_runtime/techwoman_mailer (superusuária local ou operador membro dessas roles).
-- Tudo roda numa transação DESFEITA no fim (ROLLBACK): fixtures sintéticas example.invalid; só as sequences avançam (não são transacionais)
-- e o guard de Agenda fica travado por instantes. Sucesso: NOTICE 'MATRIX OK' e exit 0. Falha: ERROR 'MATRIX FAIL: <item>' e exit != 0.
-- Limites: SET ROLE dentro de sessão superusuária é checado contra a session user, por isso a negação de troca de role aqui é por pg_has_role
-- (efetivo, com herança); o teste PG também tenta SET ROLE numa sessão LOGIN real. Acesso a outras bases, pg_hba, rede, pgAdmin e host NÃO são
-- atestados por esta matriz: são do OPS no host. O runtime não tem DML nem SELECT direto de domínio (participant/mentor/match/tentativas legadas),
-- nem policy RLS: tudo passa pelas operações SQL do owner; só lê event_content/demo_seed_state (home). Vale também depois de grants-local.sql.
-- D-048: a editora (techwoman_beatriz) é SOMENTE LEITURA; toda escrita dela é uma negação executada; DML direto de agenda é do dono/operador.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE FUNCTION pg_temp.matrix_count(p_key text) RETURNS void LANGUAGE sql AS $$
 SELECT set_config(p_key, (coalesce(nullif(current_setting(p_key, true), ''), '0')::integer + 1)::text, true);
$$;
-- Negação = SQLSTATE 42501 (privilégio). Sucesso ou qualquer outro erro (regra, FK, sintaxe) não prova a negação e falha a matriz.
CREATE FUNCTION pg_temp.matrix_denied(p_label text, p_sql text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_state text; v_message text;
BEGIN
 BEGIN
  EXECUTE p_sql;
 EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = '42501' THEN PERFORM pg_temp.matrix_count('matrix.denied'); RETURN; END IF;
  v_state := SQLSTATE; v_message := SQLERRM;
 END;
 IF v_state IS NULL THEN RAISE EXCEPTION 'MATRIX FAIL: % permitido para % (%)', p_label, current_user, p_sql; END IF;
 RAISE EXCEPTION 'MATRIX FAIL: % para % não foi negado por privilégio (% %: %)', p_label, current_user, v_state, v_message, p_sql;
END $$;
CREATE FUNCTION pg_temp.matrix_allowed(p_label text, p_sql text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 EXECUTE p_sql;
 PERFORM pg_temp.matrix_count('matrix.allowed');
EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'MATRIX FAIL: % negado para % (%: %)', p_label, current_user, SQLSTATE, SQLERRM;
END $$;
-- Executa e exige um erro de negócio (não de privilégio): prova que a role chega a executar a operação.
CREATE FUNCTION pg_temp.matrix_reaches(p_label text, p_sql text, p_state text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
 BEGIN
  EXECUTE p_sql;
 EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = p_state THEN PERFORM pg_temp.matrix_count('matrix.allowed'); RETURN; END IF;
  RAISE EXCEPTION 'MATRIX FAIL: % para % terminou com % (%)', p_label, current_user, SQLSTATE, SQLERRM;
 END;
 IF p_state IS NOT NULL THEN RAISE EXCEPTION 'MATRIX FAIL: % para % não chegou à regra esperada %', p_label, current_user, p_state; END IF;
 PERFORM pg_temp.matrix_count('matrix.allowed');
END $$;
CREATE FUNCTION pg_temp.matrix_check(p_label text, p_ok boolean) RETURNS void LANGUAGE plpgsql AS $$
BEGIN IF p_ok IS NOT TRUE THEN RAISE EXCEPTION 'MATRIX FAIL: %', p_label; END IF; PERFORM pg_temp.matrix_count('matrix.checked'); END $$;
-- Toda função de internal (e SECURITY DEFINER de public) fora da lista é chamada de verdade e precisa ser recusada por privilégio.
CREATE FUNCTION pg_temp.matrix_functions_denied(p_allowed text[]) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE f record; n integer := 0;
BEGIN
 FOR f IN SELECT p.oid, s.nspname, p.proname, p.prokind,
   (SELECT string_agg(format('NULL::%s', pg_catalog.format_type(a.t, NULL)), ', ' ORDER BY a.i) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY a(t, i)) AS args
  FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace s ON s.oid = p.pronamespace
  WHERE (s.nspname = 'internal' OR (s.nspname = 'public' AND p.prosecdef)) AND p.prokind IN ('f','p') AND NOT (p.proname = ANY (p_allowed)) ORDER BY p.oid
 LOOP
  PERFORM pg_temp.matrix_denied(format('EXECUTE %s', f.oid::regprocedure),
   CASE WHEN f.prokind = 'p' THEN 'CALL ' ELSE 'SELECT ' END || quote_ident(f.nspname) || '.' || quote_ident(f.proname) || '(' || coalesce(f.args, '') || ')');
  n := n + 1;
 END LOOP;
 RETURN n;
END $$;

-- 1. Atributos, herança e catálogo de segurança (lidos pelo operador).
DO $$
DECLARE r text; v text;
BEGIN
 PERFORM pg_temp.matrix_check('techwoman_owner existe NOLOGIN sem SUPERUSER/BYPASSRLS/CREATEROLE/CREATEDB/REPLICATION',
  EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_owner' AND NOT (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication)));
 FOREACH r IN ARRAY ARRAY['techwoman_beatriz','techwoman_runtime','techwoman_mailer','techwoman_migrator'] LOOP
  PERFORM pg_temp.matrix_check(r || ' sem SUPERUSER/BYPASSRLS/CREATEROLE/REPLICATION',
   NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls OR rolcreaterole OR rolreplication)));
 END LOOP;
 FOREACH r IN ARRAY ARRAY['techwoman_beatriz','techwoman_runtime','techwoman_mailer'] LOOP
  PERFORM pg_temp.matrix_check(r || ' existe', EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r));
  FOREACH v IN ARRAY ARRAY['techwoman_owner','techwoman_beatriz','techwoman_runtime','techwoman_mailer','techwoman_migrator'] LOOP
   CONTINUE WHEN v = r OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v);
   PERFORM pg_temp.matrix_check(format('%s não herda nem troca para %s', r, v), NOT (pg_catalog.pg_has_role(r, v, 'MEMBER') OR pg_catalog.pg_has_role(r, v, 'USAGE') OR pg_catalog.pg_has_role(r, v, 'SET')));
  END LOOP;
  PERFORM pg_temp.matrix_check(r || ' não possui objetos', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = r))
   AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p WHERE p.proowner = (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = r)));
 END LOOP;
 PERFORM pg_temp.matrix_check('nenhuma role techwoman_* com BYPASSRLS', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname LIKE 'techwoman%' AND rolbypassrls));
 PERFORM pg_temp.matrix_check('nenhuma policy RLS concede linhas ao runtime/mailer', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_roles r ON r.oid = ANY (p.polroles)
  WHERE r.rolname IN ('techwoman_runtime','techwoman_mailer')));
 PERFORM pg_temp.matrix_check('FORCE RLS nas seis tabelas de Agenda/domínio', (SELECT count(*) FROM pg_catalog.pg_class c WHERE c.oid IN ('public.topic'::regclass, 'public.mentor_topic'::regclass,
  'public.cohort'::regclass, 'public.enrollment'::regclass, 'public.mentor'::regclass, 'public.participant'::regclass) AND c.relrowsecurity AND c.relforcerowsecurity) = 6);
 PERFORM pg_temp.matrix_check('nenhuma função SECURITY DEFINER sem search_path fixo pg_catalog, …, pg_temp', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
  WHERE p.pronamespace IN ('internal'::regnamespace, 'public'::regnamespace) AND p.prosecdef
   AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c ~ '^search_path=pg_catalog(, [a-z_]+)*, pg_temp$')));
 PERFORM pg_temp.matrix_check('nenhuma função SECURITY DEFINER pertence a superusuária/BYPASSRLS', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
  WHERE p.pronamespace IN ('internal'::regnamespace, 'public'::regnamespace) AND p.prosecdef AND (o.rolsuper OR o.rolbypassrls)));
 -- Dono NOLOGIN (T12/D-038): TODA SECURITY DEFINER de internal/public pertence a techwoman_owner (NOLOGIN), sem lista de exceção;
 -- nenhuma pertence a role LOGIN (migradora, runtime, mailer ou editora).
 PERFORM pg_temp.matrix_check('toda SECURITY DEFINER de internal/public pertence a techwoman_owner NOLOGIN (sem exceção)', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_roles o ON o.oid = p.proowner WHERE p.pronamespace IN ('internal'::regnamespace, 'public'::regnamespace) AND p.prosecdef
   AND (o.rolname <> 'techwoman_owner' OR o.rolcanlogin)));
 PERFORM pg_temp.matrix_check('tabelas/views/sequences da aplicação não pertencem a superusuária', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_roles o ON o.oid = c.relowner
  WHERE c.relnamespace IN ('internal'::regnamespace, 'public'::regnamespace, 'legacy_snapshot'::regnamespace) AND c.relkind IN ('r','v','S','p') AND (o.rolsuper OR o.rolbypassrls)));
 PERFORM pg_temp.matrix_check('PUBLIC sem EXECUTE em funções de internal/public da aplicação', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
  WHERE p.pronamespace IN ('internal'::regnamespace, 'public'::regnamespace) AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'));
 PERFORM pg_temp.matrix_check('PUBLIC sem USAGE/CREATE em internal e sem CREATE em public', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_namespace s, aclexplode(coalesce(s.nspacl, acldefault('n', s.nspowner))) a
  WHERE a.grantee = 0 AND ((s.nspname = 'internal') OR (s.nspname = 'public' AND a.privilege_type = 'CREATE') OR s.nspname = 'legacy_snapshot')));
END $$;

-- 2. Fixtures sintéticas R3 (desfeitas no ROLLBACK): admin vinculado a mentora, participante com e-mail de admin sem vínculo, candidata privilegiada
-- com user_id NULL e domínio comum; turmas futuras abertas para as duas mentoras.
DO $$
DECLARE v_tag text := substr(md5(random()::text || clock_timestamp()::text), 1, 12); v_admin uuid := gen_random_uuid(); v_user uuid := gen_random_uuid(); v_run uuid := gen_random_uuid();
 v_topic bigint; v_m_free bigint; v_m_admin bigint; v_p_free bigint; v_p_cand bigint; v_p_mail bigint; v_mt_free bigint; v_mt_admin bigint; v_c_free bigint; v_c_admin bigint;
BEGIN
 INSERT INTO public.app_user(id, email, status) VALUES (v_admin, format('matrix-admin-%s@example.invalid', v_tag), 'active'), (v_user, format('matrix-p-%s@example.invalid', v_tag), 'active');
 INSERT INTO public.user_role(user_id, role) VALUES (v_admin, 'admin'), (v_admin, 'mentor'), (v_user, 'participant');
 INSERT INTO public.topic(slug, name) VALUES ('matrix-' || v_tag, 'Matriz') RETURNING id INTO v_topic;
 INSERT INTO public.mentor(email, trajectory, specialties, availability, capacity, active, display_name) VALUES (format('matrix-m-%s@example.invalid', v_tag), 't', '["dados"]', 'a', 2, true, 'Matriz') RETURNING id INTO v_m_free;
 INSERT INTO public.mentor(email, trajectory, specialties, availability, capacity, active, user_id) VALUES (format('matrix-admin-%s@example.invalid', v_tag), 't', '["dados"]', 'a', 2, true, v_admin) RETURNING id INTO v_m_admin;
 INSERT INTO public.participant(email, goal, moment, interests, skills, area, token_hash, consent_version, user_id) VALUES
  (format('matrix-p-%s@example.invalid', v_tag), 'growth', 'working', '["dados"]', '["analise"]', 'dados', md5(v_tag || 'p') || md5(v_tag || 'q'), 'v1', v_user) RETURNING id INTO v_p_free;
 INSERT INTO public.participant(email, goal, moment, interests, skills, area, token_hash, consent_version) VALUES
  (format('matrix-cand-%s@example.invalid', v_tag), 'growth', 'working', '["dados"]', '["analise"]', 'dados', md5(v_tag || 'c') || md5(v_tag || 'd'), 'v0') RETURNING id INTO v_p_cand;
 INSERT INTO public.participant(email, goal, moment, interests, skills, area, token_hash, consent_version) VALUES
  (format(' MATRIX-ADMIN-%s@example.invalid', v_tag), 'growth', 'working', '["dados"]', '["analise"]', 'dados', md5(v_tag || 'e') || md5(v_tag || 'f'), 'v0') RETURNING id INTO v_p_mail;
 INSERT INTO public.migration_run(id, source_checksum, status) VALUES (v_run, 'matrix-' || v_tag, 'pending');
 INSERT INTO public.migration_identity_link(run_id, source_table, source_key, user_id, resolution) VALUES (v_run, 'participant', v_p_cand::text, NULL, 'privileged_candidate');
 INSERT INTO public.mentor_topic(mentor_id, topic_id, position) VALUES (v_m_free, v_topic, 1) RETURNING id INTO v_mt_free;
 INSERT INTO public.mentor_topic(mentor_id, topic_id, position) VALUES (v_m_admin, v_topic, 1) RETURNING id INTO v_mt_admin;
 INSERT INTO public.cohort(mentor_topic_id, starts_at, ends_at, capacity, status) VALUES (v_mt_free, now() + interval '400 days', now() + interval '400 days 1 hour', 3, 'open') RETURNING id INTO v_c_free;
 INSERT INTO public.cohort(mentor_topic_id, starts_at, ends_at, capacity, status) VALUES (v_mt_admin, now() + interval '400 days', now() + interval '400 days 1 hour', 3, 'open') RETURNING id INTO v_c_admin;
 PERFORM set_config('matrix.tag', v_tag, true), set_config('matrix.topic', v_topic::text, true), set_config('matrix.m_free', v_m_free::text, true), set_config('matrix.m_admin', v_m_admin::text, true),
  set_config('matrix.p_free', v_p_free::text, true), set_config('matrix.p_cand', v_p_cand::text, true), set_config('matrix.p_mail', v_p_mail::text, true),
  set_config('matrix.mt_free', v_mt_free::text, true), set_config('matrix.mt_admin', v_mt_admin::text, true), set_config('matrix.c_free', v_c_free::text, true), set_config('matrix.c_admin', v_c_admin::text, true);
END $$;

-- 3. DML direto do dono (operador/administrador; a editora não escreve mais) = efeitos da API: match current selected com ranking,
-- job reservation, auditoria com ator NULL no SQL direto.
DO $$
DECLARE e bigint;
BEGIN
 INSERT INTO public.enrollment(participant_id, cohort_id, status) VALUES (current_setting('matrix.p_free')::bigint, current_setting('matrix.c_free')::bigint, 'active') RETURNING id INTO e;
 PERFORM set_config('matrix.e_free', e::text, true);
 PERFORM pg_temp.matrix_check('INSERT direto do dono cria match selected com score do ranking', EXISTS (SELECT 1 FROM public.match x WHERE x.enrollment_id = e AND x.status = 'selected' AND x.origin = 'current'
  AND x.score = (internal.agenda_ranking(x.participant_id, x.mentor_id)).o_score));
 PERFORM pg_temp.matrix_check('INSERT direto do dono cria job reservation queued', EXISTS (SELECT 1 FROM public.email_job j WHERE j.enrollment_id = e AND j.kind = 'reservation' AND j.status = 'queued'));
 PERFORM pg_temp.matrix_check('INSERT direto do dono audita enrollment.create com ator NULL', EXISTS (SELECT 1 FROM public.audit_event a WHERE a.entity_type = 'enrollment' AND a.entity_id = e::text AND a.action = 'enrollment.create' AND a.actor_user_id IS NULL));
END $$;

-- 4. Editora (Beatriz/pgAdmin): SOMENTE LEITURA (D-048, 20261026140000_beatriz_read_only.sql). Lê agenda, views seguras e perfil por coluna sob R3;
-- toda escrita (agenda, perfis, views, colunas, sequences) é negada por privilégio. Nesta matriz a role vem por SET ROLE, que não carrega
-- default_transaction_read_only: as negações provam o privilégio; o setting (primeira camada das sessões LOGIN) é conferido no catálogo.
DO $$ BEGIN
 PERFORM pg_temp.matrix_check('editora: default_transaction_read_only=on nesta base (sessões LOGIN novas nascem read-only)', EXISTS (SELECT 1 FROM pg_catalog.pg_db_role_setting s, unnest(s.setconfig) c
  WHERE s.setrole = 'techwoman_beatriz'::regrole AND s.setdatabase = (SELECT oid FROM pg_catalog.pg_database WHERE datname = current_database()) AND c = 'default_transaction_read_only=on'));
 PERFORM pg_temp.matrix_check('editora: policies agenda_editor só FOR SELECT nas seis tabelas, sem WITH CHECK', (SELECT count(*) FROM pg_catalog.pg_policy p WHERE 'techwoman_beatriz'::regrole = ANY (p.polroles)) = 6
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy p WHERE 'techwoman_beatriz'::regrole = ANY (p.polroles) AND (p.polcmd <> 'r' OR p.polwithcheck IS NOT NULL OR p.polname <> 'agenda_editor')));
 PERFORM pg_temp.matrix_check('editora: nenhuma ACL de escrita (tabela/view/coluna/sequence, qualquer grantor) nem default ACL', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
   WHERE c.relnamespace IN ('internal'::regnamespace, 'public'::regnamespace, 'legacy_snapshot'::regnamespace) AND a.grantee = 'techwoman_beatriz'::regrole AND (c.relkind = 'S' OR a.privilege_type <> 'SELECT'))
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_attribute t JOIN pg_catalog.pg_class c ON c.oid = t.attrelid, aclexplode(t.attacl) a
   WHERE c.relnamespace IN ('internal'::regnamespace, 'public'::regnamespace, 'legacy_snapshot'::regnamespace) AND a.grantee = 'techwoman_beatriz'::regrole AND a.privilege_type <> 'SELECT')
  AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_default_acl d, aclexplode(d.defaclacl) a WHERE a.grantee = 'techwoman_beatriz'::regrole));
 PERFORM pg_temp.matrix_check('editora: nenhuma escrita efetiva (inclusive via PUBLIC) em tabela/view/coluna/sequence', NOT EXISTS (SELECT 1 FROM pg_catalog.pg_class c
   WHERE c.relnamespace IN ('internal'::regnamespace, 'public'::regnamespace, 'legacy_snapshot'::regnamespace)
     AND ((c.relkind IN ('r','v','p','m','f') AND (has_table_privilege('techwoman_beatriz', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            OR has_any_column_privilege('techwoman_beatriz', c.oid, 'INSERT, UPDATE, REFERENCES')))
       OR (c.relkind = 'S' AND has_sequence_privilege('techwoman_beatriz', c.oid, 'USAGE, UPDATE, SELECT')))));
END $$;
SET LOCAL ROLE techwoman_beatriz;
DO $$
DECLARE q text; t text; c record;
BEGIN
 -- leitura permitida: agenda inteira, perfil por coluna e views seguras; R3 esconde protegidos (vinculado, e-mail de admin, candidata NULL)
 PERFORM pg_temp.matrix_allowed('editora lê agenda', 'SELECT (SELECT count(*) FROM public.topic) + (SELECT count(*) FROM public.mentor_topic) + (SELECT count(*) FROM public.cohort) + (SELECT count(*) FROM public.enrollment)');
 PERFORM pg_temp.matrix_allowed('editora lê perfil de participante por coluna', 'SELECT id, goal, moment, interests, skills, area, active, version, created_at, updated_at FROM public.participant');
 PERFORM pg_temp.matrix_allowed('editora lê perfil de mentora por coluna', 'SELECT id, display_name, trajectory, specialties, availability, capacity, active, demo, version, created_at, updated_at FROM public.mentor');
 PERFORM pg_temp.matrix_allowed('editora lê views seguras', 'SELECT (SELECT count(*) FROM public.participant_editor) + (SELECT count(*) FROM public.mentor_editor)');
 PERFORM pg_temp.matrix_check('R3: participante comum visível', (SELECT count(*) FROM public.participant WHERE id = current_setting('matrix.p_free')::bigint) = 1);
 PERFORM pg_temp.matrix_check('R3: candidata privilegiada (user_id NULL) oculta', (SELECT count(*) FROM public.participant_editor WHERE id = current_setting('matrix.p_cand')::bigint) = 0);
 PERFORM pg_temp.matrix_check('R3: participante com e-mail de admin oculta', (SELECT count(*) FROM public.participant WHERE id = current_setting('matrix.p_mail')::bigint) = 0);
 PERFORM pg_temp.matrix_check('R3: mentora vinculada a admin oculta (tabela, view, tema e turma)', (SELECT count(*) FROM public.mentor WHERE id = current_setting('matrix.m_admin')::bigint) = 0
  AND (SELECT count(*) FROM public.mentor_editor WHERE id = current_setting('matrix.m_admin')::bigint) = 0
  AND (SELECT count(*) FROM public.mentor_topic WHERE id = current_setting('matrix.mt_admin')::bigint) = 0 AND (SELECT count(*) FROM public.cohort WHERE id = current_setting('matrix.c_admin')::bigint) = 0);
 PERFORM pg_temp.matrix_check('R3: reserva feita pelo dono visível para a editora (leitura de enrollment)', (SELECT count(*) FROM public.enrollment WHERE id = current_setting('matrix.e_free')::bigint) = 1);
 -- R3: escrita em linha protegida negada (privilégio; antes do D-048 afetava 0 linhas pela RLS)
 PERFORM pg_temp.matrix_denied('R3: UPDATE em participante protegida', format('UPDATE public.participant SET goal = %L WHERE id IN (%s, %s)', 'leadership', current_setting('matrix.p_cand'), current_setting('matrix.p_mail')));
 PERFORM pg_temp.matrix_denied('R3: UPDATE em mentora protegida (view)', format('UPDATE public.mentor_editor SET trajectory = %L WHERE id = %s', 'x', current_setting('matrix.m_admin')));
 PERFORM pg_temp.matrix_denied('R3: UPDATE em turma de mentora protegida', format('UPDATE public.cohort SET capacity = 4 WHERE id = %s', current_setting('matrix.c_admin')));
 PERFORM pg_temp.matrix_denied('R3: inscrição de candidata protegida', format('INSERT INTO public.enrollment(participant_id, cohort_id, status) VALUES (%s, %s, %L)', current_setting('matrix.p_cand'), current_setting('matrix.c_free'), 'active'));
 PERFORM pg_temp.matrix_denied('R3: turma em tema de mentora protegida', format('INSERT INTO public.cohort(mentor_topic_id, starts_at, ends_at, capacity, status) VALUES (%s, now() + interval %L, now() + interval %L, 2, %L)', current_setting('matrix.mt_admin'), '401 days', '401 days 1 hour', 'open'));
 PERFORM pg_temp.matrix_denied('R3: tema em mentora protegida', format('INSERT INTO public.mentor_topic(mentor_id, topic_id, position) VALUES (%s, %s, 2)', current_setting('matrix.m_admin'), current_setting('matrix.topic')));
 -- escrita que o WP-003 concedia (perfil pelas views, agenda, sequences, reserva e cancelamento): negada em linha visível
 PERFORM pg_temp.matrix_denied('editora somente leitura: perfil pela view', format('UPDATE public.participant_editor SET goal = %L WHERE id = %s', 'leadership', current_setting('matrix.p_free')));
 PERFORM pg_temp.matrix_denied('editora somente leitura: mentora pela view', format('UPDATE public.mentor_editor SET trajectory = %L, display_name = %L WHERE id = %s', 'Trajetória matriz', 'Matriz 2', current_setting('matrix.m_free')));
 PERFORM pg_temp.matrix_denied('editora somente leitura: perfil na tabela', format('UPDATE public.participant SET goal = %L WHERE id = %s', 'leadership', current_setting('matrix.p_free')));
 PERFORM pg_temp.matrix_denied('editora somente leitura: mentora na tabela', format('UPDATE public.mentor SET trajectory = %L WHERE id = %s', 'x', current_setting('matrix.m_free')));
 PERFORM pg_temp.matrix_denied('editora somente leitura: cria tema', format('INSERT INTO public.topic(slug, name, description) VALUES (%L, %L, %L)', 'matrix-b-' || current_setting('matrix.tag'), 'Matriz B', ''));
 PERFORM pg_temp.matrix_denied('editora somente leitura: altera tema', format('UPDATE public.topic SET name = %L WHERE id = %s', 'Matriz C', current_setting('matrix.topic')));
 PERFORM pg_temp.matrix_denied('editora somente leitura: cria vínculo de tema', format('INSERT INTO public.mentor_topic(mentor_id, topic_id, position) VALUES (%s, %s, 2)', current_setting('matrix.m_free'), current_setting('matrix.topic')));
 PERFORM pg_temp.matrix_denied('editora somente leitura: reordena vínculo de tema', format('UPDATE public.mentor_topic SET position = 2 WHERE id = %s', current_setting('matrix.mt_free')));
 PERFORM pg_temp.matrix_denied('editora somente leitura: remove vínculo de tema', format('DELETE FROM public.mentor_topic WHERE id = %s', current_setting('matrix.mt_free')));
 PERFORM pg_temp.matrix_denied('editora somente leitura: cria turma', format('INSERT INTO public.cohort(mentor_topic_id, starts_at, ends_at, capacity, status) VALUES (%s, now() + interval %L, now() + interval %L, 2, %L)', current_setting('matrix.mt_free'), '402 days', '402 days 1 hour', 'draft'));
 PERFORM pg_temp.matrix_denied('editora somente leitura: altera capacidade', format('UPDATE public.cohort SET capacity = 4 WHERE id = %s', current_setting('matrix.c_free')));
 PERFORM pg_temp.matrix_denied('editora somente leitura: status de turma (nem chega à regra do banco)', format('UPDATE public.cohort SET status = %L WHERE id = %s', 'bogus', current_setting('matrix.c_free')));
 PERFORM pg_temp.matrix_denied('editora somente leitura: reserva', format('INSERT INTO public.enrollment(participant_id, cohort_id, status) VALUES (%s, %s, %L)', current_setting('matrix.p_free'), current_setting('matrix.c_free'), 'active'));
 PERFORM pg_temp.matrix_denied('editora somente leitura: cancela reserva', format('UPDATE public.enrollment SET status = %L WHERE id = %s', 'cancelled', current_setting('matrix.e_free')));
 FOREACH q IN ARRAY ARRAY['public.topic_id_seq', 'public.mentor_topic_id_seq', 'public.cohort_id_seq', 'public.enrollment_id_seq'] LOOP
  PERFORM pg_temp.matrix_denied('editora somente leitura: sequence de agenda ' || q, format('SELECT nextval(%L)', q));
 END LOOP;
 -- varredura: INSERT/UPDATE de cada coluna gravável, DELETE e TRUNCATE de cada tabela/view de agenda e perfil (WHERE false: só o privilégio decide)
 FOR c IN SELECT r.oid::regclass AS rel, r.relkind, a.attname FROM pg_catalog.pg_class r JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid
   WHERE r.oid IN ('public.topic'::regclass, 'public.mentor_topic'::regclass, 'public.cohort'::regclass, 'public.enrollment'::regclass, 'public.participant'::regclass, 'public.mentor'::regclass,
                   'public.participant_editor'::regclass, 'public.mentor_editor'::regclass)
     AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '' AND a.attidentity <> 'a' ORDER BY r.oid, a.attnum LOOP
  PERFORM pg_temp.matrix_denied(format('editora somente leitura: UPDATE %s.%s', c.rel, c.attname), format('UPDATE %s SET %I = %I WHERE false', c.rel, c.attname, c.attname));
  PERFORM pg_temp.matrix_denied(format('editora somente leitura: INSERT %s.%s', c.rel, c.attname), format('INSERT INTO %s(%I) SELECT NULL WHERE false', c.rel, c.attname));
 END LOOP;
 FOR c IN SELECT r.oid::regclass AS rel, r.relkind FROM pg_catalog.pg_class r
   WHERE r.oid IN ('public.topic'::regclass, 'public.mentor_topic'::regclass, 'public.cohort'::regclass, 'public.enrollment'::regclass, 'public.participant'::regclass, 'public.mentor'::regclass,
                   'public.participant_editor'::regclass, 'public.mentor_editor'::regclass) ORDER BY r.oid LOOP
  PERFORM pg_temp.matrix_denied(format('editora somente leitura: DELETE %s', c.rel), format('DELETE FROM %s WHERE false', c.rel));
  IF c.relkind = 'r' THEN PERFORM pg_temp.matrix_denied(format('editora somente leitura: TRUNCATE %s', c.rel), format('TRUNCATE %s', c.rel)); END IF;
 END LOOP;
 -- DDL, TRUNCATE, DISABLE TRIGGER, RLS/policies, ownership: negados
 FOREACH q IN ARRAY ARRAY['CREATE TABLE public.matrix_forbidden(id int)', 'CREATE TABLE internal.matrix_forbidden(id int)', 'CREATE SCHEMA matrix_forbidden', 'CREATE VIEW public.matrix_forbidden AS SELECT 1',
  'CREATE FUNCTION internal.matrix_forbidden() RETURNS int LANGUAGE sql AS $f$SELECT 1$f$', 'CREATE OR REPLACE FUNCTION internal.agenda_editor_visible(p_kind text, p_id bigint) RETURNS boolean LANGUAGE sql AS $f$SELECT true$f$',
  'ALTER FUNCTION internal.agenda_editor_visible(text,bigint) OWNER TO techwoman_beatriz', 'ALTER TABLE public.cohort ADD COLUMN matrix_x int', 'DROP TABLE public.enrollment', 'DROP VIEW public.participant_editor',
  'ALTER TABLE public.cohort DISABLE TRIGGER agenda_validate', 'ALTER TABLE public.enrollment DISABLE TRIGGER ALL', 'ALTER TABLE public.mentor DISABLE TRIGGER agenda_guard',
  'ALTER TABLE public.participant NO FORCE ROW LEVEL SECURITY', 'ALTER TABLE public.participant DISABLE ROW LEVEL SECURITY', 'CREATE POLICY matrix_x ON public.participant USING (true)', 'DROP POLICY agenda_editor ON public.participant',
  'CREATE TRIGGER matrix_x BEFORE INSERT ON public.topic FOR EACH ROW EXECUTE FUNCTION internal.touch_version()', 'COMMENT ON TABLE public.topic IS $c$x$c$', 'ALTER SEQUENCE public.topic_id_seq RESTART',
  'SELECT setval(''public.topic_id_seq'', 1)', 'LOCK TABLE internal.agenda_guard', 'GRANT SELECT ON public.app_user TO techwoman_beatriz', 'TRUNCATE public.enrollment', 'TRUNCATE public.topic', 'TRUNCATE public.cohort',
  'TRUNCATE public.mentor_topic', 'TRUNCATE public.participant', 'TRUNCATE public.mentor', 'TRUNCATE public.match', 'TRUNCATE public.audit_event'] LOOP
  PERFORM pg_temp.matrix_denied('editora DDL/TRUNCATE/trigger/RLS', q);
 END LOOP;
 -- leitura negada: identidade, sessão, reset, outbox, mapa/legado, guard, auditoria, hashes/e-mail/token e tabela inteira
 FOREACH t IN ARRAY ARRAY['public.app_user', 'public.user_role', 'public.auth_session', 'public.password_reset_token', 'public.email_job', 'public.email_delivery_attempt', 'public.api_idempotency',
  'public.auth_rate_bucket', 'public.audit_event', 'public.match', 'public.email_attempt', 'public.choice_email_attempt', 'public.event_content', 'public.demo_seed_state', 'public.migration_run',
  'public.migration_identity_link', 'public.migration_issue', 'legacy_snapshot.source_table', 'legacy_snapshot.source_row', 'internal.agenda_guard', 'internal.api_context', 'internal.schema_migration',
  'public.participant', 'public.mentor'] LOOP
  PERFORM pg_temp.matrix_denied('editora SELECT * ' || t, 'SELECT * FROM ' || t || ' LIMIT 1');
 END LOOP;
 FOREACH q IN ARRAY ARRAY['SELECT password_hash FROM public.app_user', 'SELECT token_hash FROM public.auth_session', 'SELECT token_hash FROM public.participant', 'SELECT email FROM public.participant',
  'SELECT user_id FROM public.participant', 'SELECT consent_version, consent_at FROM public.participant', 'SELECT legacy_access_revoked_at FROM public.participant', 'SELECT email FROM public.mentor',
  'SELECT user_id FROM public.mentor', 'SELECT demo_name FROM public.mentor', 'SELECT consent_version FROM public.mentor'] LOOP
  PERFORM pg_temp.matrix_denied('editora coluna sensível', q);
 END LOOP;
 -- escrita negada: PK/FKs de identidade, role, consentimento, auditoria, guard, DELETE físico, sequences de identidade
 FOREACH q IN ARRAY ARRAY['INSERT INTO public.participant(email, goal, moment, interests, skills, token_hash, consent_version) VALUES ($x$a@example.invalid$x$, $x$growth$x$, $x$working$x$, $x$[]$x$, $x$[]$x$, $x$t$x$, $x$v$x$)',
  'UPDATE public.participant SET email = email', 'UPDATE public.participant SET token_hash = token_hash', 'UPDATE public.participant SET user_id = NULL', 'UPDATE public.participant SET consent_version = consent_version',
  'UPDATE public.participant SET id = id', 'UPDATE public.participant SET legacy_access_revoked_at = NULL', 'DELETE FROM public.participant', 'DELETE FROM public.participant_editor',
  'INSERT INTO public.mentor(email, trajectory, specialties, availability, capacity) VALUES ($x$a@example.invalid$x$, $x$t$x$, $x$[]$x$, $x$a$x$, 1)', 'UPDATE public.mentor SET email = email',
  'UPDATE public.mentor SET user_id = NULL', 'UPDATE public.mentor SET demo = demo', 'UPDATE public.mentor SET demo_name = NULL', 'UPDATE public.mentor SET id = id', 'DELETE FROM public.mentor',
  'UPDATE public.enrollment SET participant_id = participant_id', 'UPDATE public.enrollment SET cohort_id = cohort_id', 'UPDATE public.enrollment SET cancelled_at = NULL', 'UPDATE public.enrollment SET id = id',
  'DELETE FROM public.enrollment', 'UPDATE public.cohort SET mentor_topic_id = mentor_topic_id', 'UPDATE public.cohort SET id = id', 'DELETE FROM public.cohort', 'UPDATE public.topic SET slug = slug', 'DELETE FROM public.topic',
  'UPDATE public.mentor_topic SET mentor_id = mentor_id', 'UPDATE public.mentor_topic SET topic_id = topic_id', 'INSERT INTO public.match(participant_id, mentor_id, score, reasons, status, origin) VALUES (1, 1, 0, $x$[]$x$, $x$suggested$x$, $x$current$x$)',
  'UPDATE public.match SET status = status', 'DELETE FROM public.match', 'INSERT INTO public.user_role(user_id, role) VALUES (gen_random_uuid(), $x$admin$x$)', 'UPDATE public.app_user SET status = status',
  'INSERT INTO public.audit_event(action, entity_type, entity_id, changed_fields, result, request_id) VALUES ($x$x$x$, $x$x$x$, $x$1$x$, $x$[]$x$, $x$ok$x$, gen_random_uuid())', 'UPDATE public.audit_event SET result = result', 'DELETE FROM public.audit_event',
  'UPDATE public.email_job SET status = status', 'UPDATE internal.agenda_guard SET revision = revision', 'UPDATE public.event_content SET venue = venue',
  'SELECT nextval(''public.participant_id_seq'')', 'SELECT nextval(''public.mentor_id_seq'')', 'SELECT nextval(''public.match_id_seq'')', 'SELECT nextval(''public.audit_event_id_seq'')'] LOOP
  PERFORM pg_temp.matrix_denied('editora escrita fora do perfil', q);
 END LOOP;
 PERFORM pg_temp.matrix_check('editora: todas as demais funções de internal negadas', pg_temp.matrix_functions_denied(ARRAY['agenda_editor_visible']) > 0);
END $$;
RESET ROLE;

-- 5. Cancelamento direto do dono: match cancelled, job cancelled, auditoria; status inválido de turma recusado pela regra do banco, não por privilégio.
DO $$
DECLARE e bigint := current_setting('matrix.e_free')::bigint;
BEGIN
 UPDATE public.enrollment SET status = 'cancelled' WHERE id = e;
 PERFORM pg_temp.matrix_check('cancelamento direto do dono: match cancelled, job cancelled, auditoria', EXISTS (SELECT 1 FROM public.enrollment x WHERE x.id = e AND x.status = 'cancelled' AND x.cancelled_at IS NOT NULL)
  AND EXISTS (SELECT 1 FROM public.match x WHERE x.enrollment_id = e AND x.status = 'cancelled')
  AND EXISTS (SELECT 1 FROM public.email_job j WHERE j.enrollment_id = e AND j.status = 'cancelled')
  AND EXISTS (SELECT 1 FROM public.audit_event a WHERE a.entity_id = e::text AND a.action = 'enrollment.cancel'));
 PERFORM pg_temp.matrix_reaches('dono: status de turma inválido recusado pela regra do banco, não por privilégio', format('UPDATE public.cohort SET status = %L WHERE id = %s', 'bogus', current_setting('matrix.c_free')), '23514');
END $$;

-- 6. Runtime (web): só operações autorizadas; nenhum DML direto de Agenda, identidade, fila, auditoria, mapa/legado ou guard.
SET LOCAL ROLE techwoman_runtime;
DO $$
DECLARE q text; t text;
 v_allowed constant text[] := ARRAY['add_own_mentor_profile','add_own_participant_profile','admin_user_create','admin_user_disable','admin_user_get','admin_user_list','admin_user_resend','admin_user_update',
  'api_admin_domain_create','api_admin_domain_get','api_admin_domain_list','api_admin_domain_update','api_admin_enrollment_cancel','api_admin_enrollment_get','api_admin_enrollment_list','api_admin_enrollment_reassign',
  'api_catalog_cohorts','api_catalog_mentor','api_catalog_mentors','api_cohort_create','api_cohort_get','api_cohort_list','api_cohort_update','api_enroll','api_legacy_change','api_legacy_decide','api_legacy_event_save',
  'api_legacy_overview','api_legacy_state','api_match_create','api_match_get','api_match_list','api_match_update','api_mentor_topic_create','api_mentor_topic_delete','api_mentor_topic_get','api_mentor_topic_list',
  'api_mentor_topic_reorder','api_mentor_topic_update','api_my_enrollment_cancel','api_my_enrollments','api_recommendations','api_topic_create','api_topic_get','api_topic_list','api_topic_update','consume_reset_token',
  'idem_abort','idem_begin','idem_finish','identity_change_begin','identity_change_finish','identity_login_begin','identity_login_finish','identity_logout','identity_session_get',
  'rate_hit','register_mentor_account','register_participant_account','request_password_forgot'];
BEGIN
 PERFORM pg_temp.matrix_reaches('runtime executa operação de Agenda (sessão inválida → AUTH_REQUIRED)', 'SELECT internal.api_topic_list(NULL, NULL, 20)', 'P0001');
 PERFORM pg_temp.matrix_reaches('runtime executa adaptador legado (sessão inválida → AUTH_REQUIRED)', 'SELECT internal.api_legacy_overview(NULL)', 'P0001');
 PERFORM pg_temp.matrix_reaches('runtime consulta estado legado só pelo hash', 'SELECT internal.api_legacy_state(NULL)', NULL);
 PERFORM pg_temp.matrix_reaches('runtime valida sessão por função', 'SELECT * FROM internal.identity_session_get(NULL)', NULL);
 PERFORM pg_temp.matrix_check('runtime: funções fora da lista autorizada negadas', pg_temp.matrix_functions_denied(v_allowed) > 0);
 FOREACH t IN ARRAY ARRAY['public.app_user', 'public.user_role', 'public.auth_session', 'public.password_reset_token', 'public.email_job', 'public.email_delivery_attempt', 'public.api_idempotency', 'public.auth_rate_bucket',
  'public.audit_event', 'public.migration_run', 'public.migration_identity_link', 'public.migration_issue', 'legacy_snapshot.source_table', 'legacy_snapshot.source_row', 'internal.agenda_guard', 'internal.api_context',
  'internal.schema_migration', 'public.topic', 'public.mentor_topic', 'public.cohort', 'public.enrollment', 'public.participant', 'public.mentor', 'public.match', 'public.email_attempt',
  'public.choice_email_attempt', 'public.participant_editor', 'public.mentor_editor'] LOOP
  PERFORM pg_temp.matrix_denied('runtime SELECT * ' || t, 'SELECT * FROM ' || t || ' LIMIT 1');
 END LOOP;
 PERFORM pg_temp.matrix_allowed('runtime lê o conteúdo público da home', 'SELECT (SELECT count(*) FROM public.event_content) + (SELECT count(*) FROM public.demo_seed_state)');
 -- DML livre de domínio: identidade/token/e-mail/status/histórico protegido, aprovação legada, PK, DELETE físico e sequences
 FOREACH q IN ARRAY ARRAY['SELECT token_hash FROM public.participant', 'SELECT email FROM public.participant', 'SELECT email FROM public.mentor', 'SELECT user_id FROM public.mentor',
  format('UPDATE public.participant SET user_id = NULL WHERE id = %s', current_setting('matrix.p_free')), format('UPDATE public.participant SET legacy_access_revoked_at = NULL WHERE id = %s', current_setting('matrix.p_cand')),
  'UPDATE public.participant SET token_hash = token_hash', 'UPDATE public.participant SET email = email', 'UPDATE public.participant SET active = active', 'UPDATE public.participant SET goal = goal', 'UPDATE public.participant SET id = id',
  'DELETE FROM public.participant', 'INSERT INTO public.participant(email, goal, moment, interests, skills, token_hash, consent_version) VALUES ($x$r@example.invalid$x$, $x$growth$x$, $x$working$x$, $x$[]$x$, $x$[]$x$, $x$t$x$, $x$v$x$)',
  format('UPDATE public.mentor SET user_id = NULL WHERE id = %s', current_setting('matrix.m_admin')), 'UPDATE public.mentor SET active = active', 'UPDATE public.mentor SET demo = demo', 'DELETE FROM public.mentor',
  'INSERT INTO public.mentor(email, trajectory, specialties, availability, capacity) VALUES ($x$r@example.invalid$x$, $x$t$x$, $x$[]$x$, $x$a$x$, 1)',
  format('INSERT INTO public.match(participant_id, mentor_id, score, reasons, status, origin) VALUES (%s, %s, 0, $x$[]$x$, $x$approved$x$, $x$legacy$x$)', current_setting('matrix.p_free'), current_setting('matrix.m_free')),
  'UPDATE public.match SET status = status', 'DELETE FROM public.match', 'UPDATE public.email_attempt SET status = status', 'UPDATE public.choice_email_attempt SET status = status',
  'INSERT INTO public.email_attempt(participant_id, status) VALUES (1, $x$sent$x$)', 'UPDATE public.event_content SET venue = venue', 'DELETE FROM public.event_content',
  'INSERT INTO public.demo_seed_state(id) VALUES (1)', 'SELECT nextval(''public.participant_id_seq'')', 'SELECT nextval(''public.mentor_id_seq'')', 'SELECT nextval(''public.match_id_seq'')'] LOOP
  PERFORM pg_temp.matrix_denied('runtime DML/leitura livre de domínio', q);
 END LOOP;
 FOREACH q IN ARRAY ARRAY['SELECT password_hash, temporary_password_hash FROM public.app_user', 'SELECT token_hash FROM public.auth_session', 'SELECT token_hash FROM public.password_reset_token',
  'INSERT INTO public.topic(slug, name) VALUES ($x$matrix-r$x$, $x$x$x$)', 'UPDATE public.cohort SET capacity = capacity', 'UPDATE public.enrollment SET status = status', 'DELETE FROM public.mentor_topic',
  'INSERT INTO public.enrollment(participant_id, cohort_id, status) VALUES (1, 1, $x$active$x$)', 'INSERT INTO public.user_role(user_id, role) VALUES (gen_random_uuid(), $x$admin$x$)', 'UPDATE public.user_role SET role = role',
  'UPDATE public.app_user SET status = status', 'UPDATE public.app_user SET password_hash = password_hash', 'INSERT INTO public.auth_session(id, user_id, token_hash, scope, session_version, expires_at) VALUES (gen_random_uuid(), gen_random_uuid(), $x$x$x$, $x$full$x$, 0, now())',
  'UPDATE public.email_job SET status = status', 'INSERT INTO public.audit_event(action, entity_type, entity_id, changed_fields, result, request_id) VALUES ($x$x$x$, $x$x$x$, $x$1$x$, $x$[]$x$, $x$ok$x$, gen_random_uuid())',
  'UPDATE public.audit_event SET result = result', 'DELETE FROM public.audit_event', 'UPDATE internal.agenda_guard SET revision = revision', 'DELETE FROM public.api_idempotency',
  'SELECT nextval(''public.topic_id_seq'')', 'SELECT nextval(''public.cohort_id_seq'')', 'SELECT nextval(''public.enrollment_id_seq'')', 'SELECT nextval(''public.audit_event_id_seq'')',
  'CREATE TABLE public.matrix_forbidden(id int)', 'CREATE TABLE internal.matrix_forbidden(id int)', 'CREATE FUNCTION internal.matrix_forbidden() RETURNS int LANGUAGE sql AS $f$SELECT 1$f$', 'CREATE SCHEMA matrix_forbidden',
  'ALTER TABLE public.participant DISABLE TRIGGER agenda_guard', 'ALTER TABLE public.enrollment DISABLE TRIGGER ALL', 'ALTER TABLE public.participant NO FORCE ROW LEVEL SECURITY', 'DROP TABLE public.match',
  'CREATE POLICY matrix_x ON public.enrollment USING (true)', 'TRUNCATE public.participant', 'TRUNCATE public.mentor', 'TRUNCATE public.match', 'TRUNCATE public.enrollment', 'TRUNCATE public.event_content',
  'TRUNCATE public.app_user', 'LOCK TABLE internal.agenda_guard'] LOOP
  PERFORM pg_temp.matrix_denied('runtime fora do necessário', q);
 END LOOP;
END $$;
RESET ROLE;

-- 7. Worker de e-mail: só as três funções da fila; nada de identidade/fila/domínio direto.
SET LOCAL ROLE techwoman_mailer;
DO $$
DECLARE t text;
BEGIN
 PERFORM pg_temp.matrix_check('mailer: funções fora de email_claim/emit negadas', pg_temp.matrix_functions_denied(ARRAY['email_claim','email_emit_begin','email_emit_finish']) > 0);
 FOREACH t IN ARRAY ARRAY['public.app_user', 'public.user_role', 'public.auth_session', 'public.password_reset_token', 'public.email_job', 'public.email_delivery_attempt', 'public.participant', 'public.mentor',
  'public.match', 'public.enrollment', 'public.audit_event', 'public.migration_identity_link', 'legacy_snapshot.source_row', 'internal.agenda_guard'] LOOP
  PERFORM pg_temp.matrix_denied('mailer SELECT * ' || t, 'SELECT * FROM ' || t || ' LIMIT 1');
 END LOOP;
 PERFORM pg_temp.matrix_denied('mailer DDL', 'CREATE TABLE public.matrix_forbidden(id int)');
 PERFORM pg_temp.matrix_denied('mailer escrita direta na fila', 'UPDATE public.email_job SET attempts = 0');
END $$;
RESET ROLE;

DO $$ BEGIN
 RAISE NOTICE 'MATRIX OK: % negações por privilégio executadas, % execuções permitidas, % verificações de catálogo/efeito', current_setting('matrix.denied'), current_setting('matrix.allowed'), current_setting('matrix.checked');
END $$;
ROLLBACK;
