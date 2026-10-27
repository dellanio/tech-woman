-- WP-003 Task 3: núcleo das operações HTTP de Agenda/CRUD de domínio e catálogo de temas.
-- Cada operação é UMA função SECURITY DEFINER (owner NOLOGIN techwoman_owner, search_path fixo) chamada pelo runtime com o digest da sessão:
-- ela autentica o ator, trava usuários (FOR NO KEY UPDATE, ordem de UUID) -> guard -> domínio (ordem de ID), valida DTO/autorização e grava auditoria.
-- O runtime nunca informa ator/papel; falhas saem por internal.api_fail (P0001, hint tw_api) e desfazem a transação inteira (inclusive idempotência).

-- Locks de usuário NÃO conflitam com o FOR KEY SHARE que as FKs (email_job/match/audit) tomam depois do guard na SQL da editora (ledger T2 #1).
CREATE OR REPLACE FUNCTION internal.lock_user_set(p_users uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM 1 FROM public.app_user u WHERE u.id = ANY (p_users) ORDER BY u.id FOR NO KEY UPDATE;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.lock_users(p_a uuid, p_b uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM internal.lock_user_set(ARRAY[p_a, p_b]);
END $$;
--> statement-breakpoint
-- Ator da sessão: full, versão atual, ativo e sem troca pendente, reavaliado DEPOIS de travar ator+alvos (p_lock NULL = leitura sem lock).
CREATE OR REPLACE FUNCTION internal.api_session_actor(p_digest text, p_lock uuid[], OUT o_actor uuid, OUT o_roles text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_uid uuid;
BEGIN
 IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RETURN; END IF;
 SELECT s.user_id INTO v_uid FROM public.auth_session s WHERE s.token_hash = p_digest;
 IF NOT FOUND THEN RETURN; END IF;
 IF p_lock IS NOT NULL THEN PERFORM internal.lock_user_set(array_append(p_lock, v_uid)); END IF;
 IF NOT EXISTS (SELECT 1 FROM public.auth_session s JOIN public.app_user u ON u.id = s.user_id
   WHERE s.token_hash = p_digest AND s.revoked_at IS NULL AND s.expires_at > now() AND s.scope = 'full'
    AND s.session_version = u.session_version AND u.status = 'active' AND NOT u.must_change_password) THEN RETURN; END IF;
 o_actor := v_uid;
 o_roles := ARRAY(SELECT r.role FROM public.user_role r WHERE r.user_id = v_uid ORDER BY r.role);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.lock_user_set(uuid[]), internal.lock_users(uuid,uuid), internal.api_session_actor(text,uuid[]) FROM PUBLIC;
--> statement-breakpoint
-- Ator confiável da transação para os efeitos SQL (auditoria da reserva): só funções do owner escrevem, depois de autenticar o digest.
-- Chave = xid da transação: linha de transação já encerrada nunca casa com outra; limpeza oportunista.
CREATE TABLE internal.api_context (
 xact xid8 PRIMARY KEY,
 actor uuid NOT NULL,
 request uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
REVOKE ALL ON internal.api_context FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON internal.api_context TO techwoman_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_fail(p_code text, p_fields text[] DEFAULT ARRAY[]::text[]) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = p_code, DETAIL = array_to_string(coalesce(p_fields, ARRAY[]::text[]), ','), HINT = 'tw_api';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_ts(p_value timestamptz) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE WHEN date_part('milliseconds', p_value)::numeric % 1000 = 0 THEN to_char(p_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
  ELSE to_char(p_value AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_limit(p_limit integer) RETURNS integer
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$ SELECT least(greatest(coalesce(p_limit, 20), 1), 100) + 1; $$;
--> statement-breakpoint
-- Autentica; em escrita (p_lock não NULL) trava ator+alvos e registra o ator da transação.
CREATE OR REPLACE FUNCTION internal.api_auth(p_digest text, p_lock uuid[], p_request uuid, OUT o_actor uuid, OUT o_roles text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM internal.api_session_actor(p_digest, p_lock);
 IF a.o_actor IS NULL THEN PERFORM internal.api_fail('AUTH_REQUIRED'); END IF;
 o_actor := a.o_actor; o_roles := a.o_roles;
 IF p_lock IS NOT NULL THEN
  DELETE FROM internal.api_context c WHERE c.created_at < now() - interval '1 hour';
  INSERT INTO internal.api_context(xact, actor, request) VALUES (pg_current_xact_id(), o_actor, coalesce(p_request, gen_random_uuid()))
   ON CONFLICT (xact) DO UPDATE SET actor = EXCLUDED.actor, request = EXCLUDED.request;
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_guard() RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s' AS $$
BEGIN UPDATE internal.agenda_guard SET revision = revision + 1 WHERE id = 1; END $$;
--> statement-breakpoint
-- Idempotência POST no escopo ator+method+path canônico; corpo divergente → 409. Replay devolve o recurso registrado.
CREATE OR REPLACE FUNCTION internal.api_idem(p_actor uuid, p_path text, p_key uuid, p_hash text, OUT o_new boolean, OUT o_id uuid, OUT o_resource text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE r record;
BEGIN
 IF p_key IS NULL THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['Idempotency-Key']); END IF;
 IF p_hash IS NULL OR p_hash !~ '^[a-f0-9]{64}$' THEN PERFORM internal.api_fail('INVALID_INPUT'); END IF;
 SELECT * INTO r FROM internal.idem_begin(p_actor::text, 'POST', p_path, encode(sha256(convert_to(lower(p_key::text), 'UTF8')), 'hex'), p_hash);
 IF r.o_state = 'conflict' OR (r.o_state = 'replay' AND r.o_resource IS NULL) THEN PERFORM internal.api_fail('IDEMPOTENCY_CONFLICT'); END IF;
 o_new := r.o_state = 'new'; o_id := r.o_id; o_resource := r.o_resource;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_audit(p_actor uuid, p_action text, p_entity text, p_id text, p_fields jsonb, p_request uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id)
  VALUES (p_actor, p_action, p_entity, p_id, coalesce(p_fields, '[]'::jsonb), 'ok', coalesce(p_request, gen_random_uuid()));
$$;
--> statement-breakpoint
-- PATCH fechado: objeto não vazio, só chaves permitidas (defesa em profundidade além do parser TS).
CREATE OR REPLACE FUNCTION internal.api_patch_keys(p_patch jsonb, p_allowed text[]) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['body']); END IF;
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k WHERE k <> ALL (p_allowed)) THEN
  PERFORM internal.api_fail('INVALID_INPUT', ARRAY(SELECT k FROM jsonb_object_keys(p_patch) k WHERE k <> ALL (p_allowed) ORDER BY k));
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_text(p_value jsonb, p_field text, p_min integer, p_max integer) RETURNS text
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value) <> 'string' OR length(btrim(p_value #>> '{}')) NOT BETWEEN p_min AND p_max THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY[p_field]); END IF;
 RETURN btrim(p_value #>> '{}');
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_bool(p_value jsonb, p_field text) RETURNS boolean
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value) <> 'boolean' THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY[p_field]); END IF;
 RETURN (p_value #>> '{}')::boolean;
END $$;
--> statement-breakpoint
-- ---- Temas (catálogo): leitura para perfis ativos (inativos só admin/team), escrita admin. Slug imutável.
CREATE OR REPLACE FUNCTION internal.api_topic_json(t public.topic) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('id', t.id::text, 'slug', t.slug, 'name', t.name, 'description', t.description, 'active', t.active, 'version', t.version::text);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_topic_list(p_digest text, p_after bigint, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; v_all boolean;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 IF cardinality(a.o_roles) = 0 THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 v_all := a.o_roles && ARRAY['admin','team'];
 RETURN coalesce((SELECT jsonb_agg(internal.api_topic_json(s.x) ORDER BY (s.x).id) FROM (
  SELECT x FROM public.topic x WHERE (p_after IS NULL OR x.id > p_after) AND (v_all OR x.active) ORDER BY x.id LIMIT internal.api_limit(p_limit)) s), '[]'::jsonb);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_topic_get(p_digest text, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; t public.topic%ROWTYPE;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 SELECT * INTO t FROM public.topic x WHERE x.id = p_id;
 IF NOT FOUND OR cardinality(a.o_roles) = 0 OR NOT (t.active OR a.o_roles && ARRAY['admin','team']) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 RETURN internal.api_topic_json(t);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_topic_create(p_digest text, p_request uuid, p_key uuid, p_hash text, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; i record; t public.topic%ROWTYPE; v_slug text; v_name text; v_description text := '';
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, ARRAY[]::uuid[], p_request);
 IF NOT ('admin' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 SELECT * INTO i FROM internal.api_idem(a.o_actor, '/api/v1/topics', p_key, p_hash);
 IF NOT i.o_new THEN SELECT * INTO t FROM public.topic x WHERE x.id = i.o_resource::bigint; RETURN internal.api_topic_json(t); END IF;
 PERFORM internal.api_patch_keys(p_body, ARRAY['slug','name','description']);
 v_slug := internal.api_text(p_body -> 'slug', 'slug', 1, 80);
 IF v_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' OR v_slug <> p_body ->> 'slug' THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['slug']); END IF;
 v_name := internal.api_text(p_body -> 'name', 'name', 1, 120);
 IF p_body ? 'description' THEN v_description := internal.api_text(p_body -> 'description', 'description', 0, 1000); END IF;
 PERFORM internal.api_guard();
 IF EXISTS (SELECT 1 FROM public.topic x WHERE x.slug = v_slug) THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['slug']); END IF;
 INSERT INTO public.topic(slug, name, description) VALUES (v_slug, v_name, v_description) RETURNING * INTO t;
 PERFORM internal.api_audit(a.o_actor, 'topic.create', 'topic', t.id::text, '["slug","name","description"]'::jsonb, p_request);
 PERFORM internal.idem_finish(i.o_id, t.id::text, 201);
 RETURN internal.api_topic_json(t);
END $$;
--> statement-breakpoint
-- PATCH {name?,description?,active?} e DELETE (= active false) do admin: If-Match na mesma transação, depois do guard e do lock da linha.
CREATE OR REPLACE FUNCTION internal.api_topic_update(p_digest text, p_request uuid, p_id bigint, p_version bigint, p_patch jsonb, p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; t public.topic%ROWTYPE; v_name text; v_description text; v_active boolean; v_fields text[] := ARRAY[]::text[];
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, ARRAY[]::uuid[], p_request);
 IF cardinality(a.o_roles) = 0 OR NOT EXISTS (SELECT 1 FROM public.topic x WHERE x.id = p_id AND (x.active OR a.o_roles && ARRAY['admin','team'])) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 IF NOT ('admin' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 PERFORM internal.api_patch_keys(p_patch, ARRAY['name','description','active']);
 IF p_patch ? 'name' THEN v_name := internal.api_text(p_patch -> 'name', 'name', 1, 120); END IF;
 IF p_patch ? 'description' THEN v_description := internal.api_text(p_patch -> 'description', 'description', 0, 1000); END IF;
 IF p_patch ? 'active' THEN v_active := internal.api_bool(p_patch -> 'active', 'active'); END IF;
 PERFORM internal.api_guard();
 SELECT * INTO t FROM public.topic x WHERE x.id = p_id FOR NO KEY UPDATE;
 IF NOT FOUND THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 IF t.version IS DISTINCT FROM p_version THEN PERFORM internal.api_fail('VERSION_MISMATCH'); END IF;
 IF v_name IS NOT NULL AND v_name <> t.name THEN v_fields := array_append(v_fields, 'name'); END IF;
 IF v_description IS NOT NULL AND v_description <> t.description THEN v_fields := array_append(v_fields, 'description'); END IF;
 IF v_active IS NOT NULL AND v_active <> t.active THEN v_fields := array_append(v_fields, 'active'); END IF;
 IF cardinality(v_fields) = 0 THEN RETURN internal.api_topic_json(t); END IF;
 UPDATE public.topic x SET name = coalesce(v_name, x.name), description = coalesce(v_description, x.description), active = coalesce(v_active, x.active)
  WHERE x.id = p_id RETURNING * INTO t;
 PERFORM internal.api_audit(a.o_actor, CASE WHEN p_action = 'deactivate' THEN 'topic.deactivate' ELSE 'topic.update' END, 'topic', t.id::text, to_jsonb(v_fields), p_request);
 RETURN internal.api_topic_json(t);
END $$;
--> statement-breakpoint
-- Escrita das funções de API: o owner (NOLOGIN) recebe só o necessário; políticas explícitas de escrita apenas para ele.
GRANT INSERT (slug, name, description), UPDATE (name, description, active) ON public.topic TO techwoman_owner;
GRANT USAGE ON SEQUENCE public.topic_id_seq TO techwoman_owner;
GRANT UPDATE ON internal.agenda_guard TO techwoman_owner;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['topic','mentor_topic','cohort','enrollment','mentor','participant'] LOOP
  EXECUTE format('CREATE POLICY agenda_api_owner_insert ON public.%I FOR INSERT TO techwoman_owner WITH CHECK (true)', t);
  EXECUTE format('CREATE POLICY agenda_api_owner_update ON public.%I FOR UPDATE TO techwoman_owner USING (true) WITH CHECK (true)', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Identidade (funções da migradora, como WP-002): só o owner das funções de API executa.
GRANT EXECUTE ON FUNCTION internal.api_session_actor(text,uuid[]), internal.lock_user_set(uuid[]), internal.idem_begin(text,text,text,text,text), internal.idem_finish(uuid,text,integer),
 internal.user_protected(uuid) TO techwoman_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.api_fail(text,text[]), internal.api_ts(timestamptz), internal.api_limit(integer), internal.api_auth(text,uuid[],uuid), internal.api_guard(),
 internal.api_idem(uuid,text,uuid,text), internal.api_audit(uuid,text,text,text,jsonb,uuid), internal.api_patch_keys(jsonb,text[]), internal.api_text(jsonb,text,integer,integer),
 internal.api_bool(jsonb,text), internal.api_topic_json(public.topic), internal.api_topic_list(text,bigint,integer), internal.api_topic_get(text,bigint),
 internal.api_topic_create(text,uuid,uuid,text,jsonb), internal.api_topic_update(text,uuid,bigint,bigint,jsonb,text) FROM PUBLIC;
--> statement-breakpoint
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.api_fail(text,text[]) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_ts(timestamptz) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_limit(integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_auth(text,uuid[],uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_guard() OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_idem(uuid,text,uuid,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_audit(uuid,text,text,text,jsonb,uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_patch_keys(jsonb,text[]) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_text(jsonb,text,integer,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_bool(jsonb,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_topic_json(public.topic) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_topic_list(text,bigint,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_topic_get(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_topic_create(text,uuid,uuid,text,jsonb) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_topic_update(text,uuid,bigint,bigint,jsonb,text) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
-- Runtime: somente as operações (nunca helpers, ranking, elegibilidade ou contexto).
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.api_topic_list(text,bigint,integer), internal.api_topic_get(text,bigint), internal.api_topic_create(text,uuid,uuid,text,jsonb),
   internal.api_topic_update(text,uuid,bigint,bigint,jsonb,text) TO techwoman_runtime;
 END IF;
END $$;
