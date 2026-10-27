-- WP-003 Task 3: CRUD administrativo de participantes e mentoras (/admin/participants, /admin/mentors).
-- Leitura admin/team, escrita admin. Predicado de proteção (internal.domain_protected: admin/team vinculado, e-mail de admin/team,
-- candidato privilegiado com user_id NULL) aplicado na consulta e revalidado sob o lock da conta antes de escrever → 404 idêntico ao inexistente.
-- POST cria conta pendente + papel + domínio + intenção de ativação numa transação (sem usuário órfão); e-mail indisponível → 409 genérico.

-- Identidade (função da migradora, como as de WP-002): só o owner das operações executa. NULL = destino indisponível (sem dizer qual).
CREATE OR REPLACE FUNCTION internal.api_account_create(p_email text, p_role text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid := gen_random_uuid(); v_email text := btrim(p_email);
BEGIN
 IF p_role IS NULL OR p_role NOT IN ('participant','mentor') OR v_email IS NULL OR length(v_email) NOT BETWEEN 3 AND 254 OR v_email !~ '^[\x21-\x7e]+@[^@\s]+\.[^@\s]+$' THEN
  RAISE EXCEPTION 'invalid account request';
 END IF;
 IF internal.email_destination_taken(v_email, NULL) THEN RETURN NULL; END IF;
 INSERT INTO public.app_user(id, email, status) VALUES (v_user, v_email, 'pending_activation');
 INSERT INTO public.user_role(user_id, role) VALUES (v_user, p_role);
 RETURN v_user;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.api_account_create(text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION internal.api_account_create(text,text) TO techwoman_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_tags(p_value jsonb, p_allowed text[], p_max integer, p_field text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value) <> 'array' OR jsonb_array_length(p_value) NOT BETWEEN 1 AND p_max
  OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_value) v WHERE jsonb_typeof(v) <> 'string' OR NOT ((v #>> '{}') = ANY (p_allowed)))
  OR (SELECT count(DISTINCT v) FROM jsonb_array_elements(p_value) v) <> jsonb_array_length(p_value) THEN
  PERFORM internal.api_fail('INVALID_INPUT', ARRAY[p_field]);
 END IF;
 RETURN p_value;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_participant_admin_json(p public.participant) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('id', p.id::text, 'email', p.email, 'goal', p.goal, 'moment', p.moment, 'interests', p.interests, 'skills', p.skills,
   'area', CASE WHEN p.area LIKE 'outra: %' THEN 'outra' ELSE p.area END, 'active', p.active, 'userId', p.user_id::text, 'version', p.version::text)
  || CASE WHEN p.area LIKE 'outra: %' THEN jsonb_build_object('otherArea', substr(p.area, 8)) ELSE '{}'::jsonb END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_mentor_admin_json(m public.mentor) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('id', m.id::text, 'email', m.email, 'displayName', m.display_name, 'trajectory', m.trajectory, 'specialties', m.specialties,
  'availability', m.availability, 'legacyCapacity', m.capacity, 'active', m.active, 'demo', m.demo, 'userId', m.user_id::text, 'version', m.version::text);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_domain_json(p_kind text, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE p public.participant%ROWTYPE; m public.mentor%ROWTYPE;
BEGIN
 IF p_kind = 'participant' THEN SELECT * INTO p FROM public.participant x WHERE x.id = p_id; RETURN internal.api_participant_admin_json(p); END IF;
 SELECT * INTO m FROM public.mentor x WHERE x.id = p_id; RETURN internal.api_mentor_admin_json(m);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_domain_exists(p_kind text, p_id bigint) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE p_kind WHEN 'participant' THEN EXISTS (SELECT 1 FROM public.participant x WHERE x.id = p_id)
  WHEN 'mentor' THEN EXISTS (SELECT 1 FROM public.mentor x WHERE x.id = p_id) ELSE false END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_domain_owner(p_kind text, p_id bigint) RETURNS uuid
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE p_kind WHEN 'participant' THEN (SELECT x.user_id FROM public.participant x WHERE x.id = p_id)
  WHEN 'mentor' THEN (SELECT x.user_id FROM public.mentor x WHERE x.id = p_id) END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_admin_domain_list(p_digest text, p_kind text, p_after bigint, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 IF NOT (a.o_roles && ARRAY['admin','team']) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 IF p_kind = 'participant' THEN
  RETURN coalesce((SELECT jsonb_agg(internal.api_participant_admin_json(s.x) ORDER BY (s.x).id) FROM (SELECT x FROM public.participant x
   WHERE (p_after IS NULL OR x.id > p_after) AND NOT internal.domain_protected('participant', x.id) ORDER BY x.id LIMIT internal.api_limit(p_limit)) s), '[]'::jsonb);
 END IF;
 RETURN coalesce((SELECT jsonb_agg(internal.api_mentor_admin_json(s.x) ORDER BY (s.x).id) FROM (SELECT x FROM public.mentor x
  WHERE (p_after IS NULL OR x.id > p_after) AND NOT internal.domain_protected('mentor', x.id) ORDER BY x.id LIMIT internal.api_limit(p_limit)) s), '[]'::jsonb);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_admin_domain_get(p_digest text, p_kind text, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 IF NOT (a.o_roles && ARRAY['admin','team']) OR NOT internal.api_domain_exists(p_kind, p_id) OR internal.domain_protected(p_kind, p_id) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 RETURN internal.api_domain_json(p_kind, p_id);
END $$;
--> statement-breakpoint
-- Campos de domínio validados de novo no banco (defesa em profundidade); nunca e-mail/userId/token/consentimento/demo por PATCH.
CREATE OR REPLACE FUNCTION internal.api_participant_fields(p_body jsonb, p_partial boolean, OUT o_goal text, OUT o_moment text, OUT o_interests jsonb, OUT o_skills jsonb, OUT o_area text, OUT o_active boolean, OUT o_fields text[])
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_area text;
BEGIN
 o_fields := ARRAY[]::text[];
 IF p_body ? 'goal' OR NOT p_partial THEN
  o_goal := p_body ->> 'goal';
  IF jsonb_typeof(p_body -> 'goal') IS DISTINCT FROM 'string' OR o_goal NOT IN ('transition','growth','leadership') THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['goal']); END IF;
  o_fields := array_append(o_fields, 'goal');
 END IF;
 IF p_body ? 'moment' OR NOT p_partial THEN
  o_moment := p_body ->> 'moment';
  IF jsonb_typeof(p_body -> 'moment') IS DISTINCT FROM 'string' OR o_moment NOT IN ('starting','working','returning') THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['moment']); END IF;
  o_fields := array_append(o_fields, 'moment');
 END IF;
 IF p_body ? 'interests' OR NOT p_partial THEN o_interests := internal.api_tags(p_body -> 'interests', ARRAY['produto','dados','desenvolvimento','design'], 3, 'interests'); o_fields := array_append(o_fields, 'interests'); END IF;
 IF p_body ? 'skills' OR NOT p_partial THEN o_skills := internal.api_tags(p_body -> 'skills', ARRAY['comunicacao','analise','codigo','gestao'], 4, 'skills'); o_fields := array_append(o_fields, 'skills'); END IF;
 IF p_body ? 'otherArea' AND p_body ->> 'area' IS DISTINCT FROM 'outra' THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['otherArea']); END IF;
 IF p_body ? 'area' OR NOT p_partial THEN
  v_area := p_body ->> 'area';
  IF jsonb_typeof(p_body -> 'area') IS DISTINCT FROM 'string' OR v_area NOT IN ('produto','dados','desenvolvimento','design','outra') THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['area']); END IF;
  o_area := CASE WHEN v_area = 'outra' THEN 'outra: ' || internal.api_text(p_body -> 'otherArea', 'otherArea', 1, 80) ELSE v_area END;
  o_fields := array_append(o_fields, 'area');
 END IF;
 IF p_body ? 'active' THEN o_active := internal.api_bool(p_body -> 'active', 'active'); o_fields := array_append(o_fields, 'active'); END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_mentor_fields(p_body jsonb, p_partial boolean, OUT o_display_name text, OUT o_trajectory text, OUT o_specialties jsonb, OUT o_availability text, OUT o_capacity integer, OUT o_active boolean, OUT o_fields text[])
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 o_fields := ARRAY[]::text[];
 IF p_body ? 'displayName' OR NOT p_partial THEN o_display_name := internal.api_text(p_body -> 'displayName', 'displayName', 1, 120); o_fields := array_append(o_fields, 'displayName'); END IF;
 IF p_body ? 'trajectory' OR NOT p_partial THEN o_trajectory := internal.api_text(p_body -> 'trajectory', 'trajectory', 1, 1000); o_fields := array_append(o_fields, 'trajectory'); END IF;
 IF p_body ? 'specialties' OR NOT p_partial THEN o_specialties := internal.api_tags(p_body -> 'specialties', ARRAY['produto','dados','desenvolvimento','design'], 3, 'specialties'); o_fields := array_append(o_fields, 'specialties'); END IF;
 IF p_body ? 'availability' OR NOT p_partial THEN o_availability := internal.api_text(p_body -> 'availability', 'availability', 1, 300); o_fields := array_append(o_fields, 'availability'); END IF;
 IF p_body ? 'legacyCapacity' OR NOT p_partial THEN o_capacity := internal.api_int(p_body -> 'legacyCapacity', 'legacyCapacity', 1, 50); o_fields := array_append(o_fields, 'legacyCapacity'); END IF;
 IF p_body ? 'active' THEN o_active := internal.api_bool(p_body -> 'active', 'active'); o_fields := array_append(o_fields, 'active'); END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_admin_domain_create(p_digest text, p_request uuid, p_key uuid, p_hash text, p_kind text, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; i record; f record; v_user uuid; v_id bigint; v_email text;
BEGIN
 IF p_kind NOT IN ('participant','mentor') THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 SELECT * INTO a FROM internal.api_auth(p_digest, ARRAY[]::uuid[], p_request);
 IF NOT ('admin' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 SELECT * INTO i FROM internal.api_idem(a.o_actor, '/api/v1/admin/' || p_kind || 's', p_key, p_hash);
 IF NOT i.o_new THEN
  IF internal.domain_protected(p_kind, i.o_resource::bigint) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
  RETURN internal.api_domain_json(p_kind, i.o_resource::bigint);
 END IF;
 IF p_kind = 'participant' THEN
  PERFORM internal.api_patch_keys(p_body, ARRAY['email','goal','moment','interests','skills','area','otherArea','consent']);
  SELECT * INTO f FROM internal.api_participant_fields(p_body, false);
 ELSE
  PERFORM internal.api_patch_keys(p_body, ARRAY['email','displayName','trajectory','specialties','availability','legacyCapacity','consent']);
  SELECT * INTO f FROM internal.api_mentor_fields(p_body, false);
 END IF;
 IF p_body -> 'consent' IS DISTINCT FROM 'true'::jsonb THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['consent']); END IF;
 v_email := internal.api_text(p_body -> 'email', 'email', 3, 254);
 PERFORM internal.api_guard();
 v_user := internal.api_account_create(v_email, p_kind);
 IF v_user IS NULL THEN PERFORM internal.api_fail('EMAIL_UNAVAILABLE'); END IF;
 IF p_kind = 'participant' THEN
  INSERT INTO public.participant(email, goal, moment, interests, skills, area, token_hash, consent_version, consent_at, user_id)
   VALUES (v_email, f.o_goal, f.o_moment, f.o_interests, f.o_skills, f.o_area, encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'), 'v1', now(), v_user)
   RETURNING id INTO v_id;
  INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key, participant_id) VALUES (gen_random_uuid(), v_user, 'registration', 0, 'queued', 'registration:' || v_user::text, v_id);
 ELSE
  INSERT INTO public.mentor(email, trajectory, specialties, availability, capacity, active, demo, display_name, user_id, consent_version, consent_at)
   VALUES (v_email, f.o_trajectory, f.o_specialties, f.o_availability, f.o_capacity, true, false, f.o_display_name, v_user, 'v1', now()) RETURNING id INTO v_id;
  INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key) VALUES (gen_random_uuid(), v_user, 'registration', 0, 'queued', 'registration:' || v_user::text);
 END IF;
 PERFORM internal.api_audit(a.o_actor, p_kind || '.create', p_kind, v_id::text, to_jsonb(f.o_fields), p_request);
 PERFORM internal.idem_finish(i.o_id, v_id::text, 201);
 RETURN internal.api_domain_json(p_kind, v_id);
END $$;
--> statement-breakpoint
-- PATCH (campos de perfil + active) e DELETE (= active false): trava ator + dona da linha → guard → confirma dona → proteção sob lock → If-Match.
CREATE OR REPLACE FUNCTION internal.api_admin_domain_update(p_digest text, p_request uuid, p_kind text, p_id bigint, p_version bigint, p_patch jsonb, p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; f record; v_owner uuid; v_version bigint; v_changed text[] := ARRAY[]::text[]; p public.participant%ROWTYPE; m public.mentor%ROWTYPE;
BEGIN
 IF p_kind NOT IN ('participant','mentor') THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 v_owner := internal.api_domain_owner(p_kind, p_id);
 SELECT * INTO a FROM internal.api_auth(p_digest, CASE WHEN v_owner IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_owner] END, p_request);
 IF NOT (a.o_roles && ARRAY['admin','team']) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 PERFORM internal.api_guard();
 IF internal.api_domain_owner(p_kind, p_id) IS DISTINCT FROM v_owner THEN RAISE EXCEPTION 'domain owner changed' USING ERRCODE = '40001'; END IF;
 IF NOT internal.api_domain_exists(p_kind, p_id) OR internal.domain_protected(p_kind, p_id) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 IF NOT ('admin' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 IF p_kind = 'participant' THEN
  PERFORM internal.api_patch_keys(p_patch, ARRAY['goal','moment','interests','skills','area','otherArea','active']);
  SELECT * INTO f FROM internal.api_participant_fields(p_patch, true);
  SELECT * INTO p FROM public.participant x WHERE x.id = p_id FOR NO KEY UPDATE;
  v_version := p.version;
  IF v_version IS DISTINCT FROM p_version THEN PERFORM internal.api_fail('VERSION_MISMATCH'); END IF;
  IF f.o_goal IS DISTINCT FROM NULL AND f.o_goal <> p.goal THEN v_changed := array_append(v_changed, 'goal'); END IF;
  IF f.o_moment IS DISTINCT FROM NULL AND f.o_moment <> p.moment THEN v_changed := array_append(v_changed, 'moment'); END IF;
  IF f.o_interests IS DISTINCT FROM NULL AND f.o_interests <> p.interests THEN v_changed := array_append(v_changed, 'interests'); END IF;
  IF f.o_skills IS DISTINCT FROM NULL AND f.o_skills <> p.skills THEN v_changed := array_append(v_changed, 'skills'); END IF;
  IF f.o_area IS DISTINCT FROM NULL AND f.o_area IS DISTINCT FROM p.area THEN v_changed := array_append(v_changed, 'area'); END IF;
  IF f.o_active IS DISTINCT FROM NULL AND f.o_active <> p.active THEN v_changed := array_append(v_changed, 'active'); END IF;
  IF cardinality(v_changed) > 0 THEN
   UPDATE public.participant x SET goal = coalesce(f.o_goal, x.goal), moment = coalesce(f.o_moment, x.moment), interests = coalesce(f.o_interests, x.interests),
    skills = coalesce(f.o_skills, x.skills), area = coalesce(f.o_area, x.area), active = coalesce(f.o_active, x.active) WHERE x.id = p_id;
  END IF;
 ELSE
  PERFORM internal.api_patch_keys(p_patch, ARRAY['displayName','trajectory','specialties','availability','legacyCapacity','active']);
  SELECT * INTO f FROM internal.api_mentor_fields(p_patch, true);
  SELECT * INTO m FROM public.mentor x WHERE x.id = p_id FOR NO KEY UPDATE;
  v_version := m.version;
  IF v_version IS DISTINCT FROM p_version THEN PERFORM internal.api_fail('VERSION_MISMATCH'); END IF;
  IF f.o_display_name IS DISTINCT FROM NULL AND f.o_display_name IS DISTINCT FROM m.display_name THEN v_changed := array_append(v_changed, 'displayName'); END IF;
  IF f.o_trajectory IS DISTINCT FROM NULL AND f.o_trajectory <> m.trajectory THEN v_changed := array_append(v_changed, 'trajectory'); END IF;
  IF f.o_specialties IS DISTINCT FROM NULL AND f.o_specialties <> m.specialties THEN v_changed := array_append(v_changed, 'specialties'); END IF;
  IF f.o_availability IS DISTINCT FROM NULL AND f.o_availability <> m.availability THEN v_changed := array_append(v_changed, 'availability'); END IF;
  IF f.o_capacity IS DISTINCT FROM NULL AND f.o_capacity <> m.capacity THEN v_changed := array_append(v_changed, 'legacyCapacity'); END IF;
  IF f.o_active IS DISTINCT FROM NULL AND f.o_active <> m.active THEN v_changed := array_append(v_changed, 'active'); END IF;
  IF cardinality(v_changed) > 0 THEN
   UPDATE public.mentor x SET display_name = coalesce(f.o_display_name, x.display_name), trajectory = coalesce(f.o_trajectory, x.trajectory), specialties = coalesce(f.o_specialties, x.specialties),
    availability = coalesce(f.o_availability, x.availability), capacity = coalesce(f.o_capacity, x.capacity), active = coalesce(f.o_active, x.active) WHERE x.id = p_id;
  END IF;
 END IF;
 IF cardinality(v_changed) > 0 THEN
  PERFORM internal.api_audit(a.o_actor, p_kind || CASE WHEN p_action = 'deactivate' THEN '.deactivate' ELSE '.update' END, p_kind, p_id::text, to_jsonb(v_changed), p_request);
 END IF;
 RETURN internal.api_domain_json(p_kind, p_id);
END $$;
--> statement-breakpoint
GRANT INSERT (email, goal, moment, interests, skills, area, token_hash, consent_version, consent_at, user_id) ON public.participant TO techwoman_owner;
GRANT INSERT (email, trajectory, specialties, availability, capacity, active, demo, display_name, user_id, consent_version, consent_at),
 UPDATE (display_name, trajectory, specialties, availability, capacity, active) ON public.mentor TO techwoman_owner;
GRANT USAGE ON SEQUENCE public.participant_id_seq, public.mentor_id_seq TO techwoman_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.api_tags(jsonb,text[],integer,text), internal.api_participant_admin_json(public.participant), internal.api_mentor_admin_json(public.mentor),
 internal.api_domain_json(text,bigint), internal.api_domain_exists(text,bigint), internal.api_domain_owner(text,bigint), internal.api_admin_domain_list(text,text,bigint,integer),
 internal.api_admin_domain_get(text,text,bigint), internal.api_participant_fields(jsonb,boolean), internal.api_mentor_fields(jsonb,boolean),
 internal.api_admin_domain_create(text,uuid,uuid,text,text,jsonb), internal.api_admin_domain_update(text,uuid,text,bigint,bigint,jsonb,text) FROM PUBLIC;
--> statement-breakpoint
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.api_tags(jsonb,text[],integer,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_participant_admin_json(public.participant) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_admin_json(public.mentor) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_domain_json(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_domain_exists(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_domain_owner(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_admin_domain_list(text,text,bigint,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_admin_domain_get(text,text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_participant_fields(jsonb,boolean) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_fields(jsonb,boolean) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_admin_domain_create(text,uuid,uuid,text,text,jsonb) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_admin_domain_update(text,uuid,text,bigint,bigint,jsonb,text) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.api_admin_domain_list(text,text,bigint,integer), internal.api_admin_domain_get(text,text,bigint),
   internal.api_admin_domain_create(text,uuid,uuid,text,text,jsonb), internal.api_admin_domain_update(text,uuid,text,bigint,bigint,jsonb,text) TO techwoman_runtime;
 END IF;
END $$;
