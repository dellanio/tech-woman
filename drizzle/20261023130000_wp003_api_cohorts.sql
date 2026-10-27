-- WP-003 Task 3: turmas (cohort) da mentora. Mesma autorização dos temas da mentora; regras de horário/transição/capacidade ficam nos
-- triggers e no validador integral (T1/T2); aqui só DTO fechado, If-Match, idempotência e auditoria com ator.
CREATE OR REPLACE FUNCTION internal.api_instant(p_value jsonb, p_field text) RETURNS timestamptz
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 -- O serviço já normalizou RFC3339 com offset obrigatório para UTC Z; aqui só aceita essa forma canônica.
 IF p_value IS NULL OR jsonb_typeof(p_value) <> 'string' OR (p_value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$' THEN
  PERFORM internal.api_fail('INVALID_INPUT', ARRAY[p_field]);
 END IF;
 RETURN (p_value #>> '{}')::timestamptz;
END $$;
--> statement-breakpoint
-- Projeção de turma. p_admin: inclui status e vínculo (gestão); catálogo público só horário/tema/vagas.
CREATE OR REPLACE FUNCTION internal.api_cohort_json(c public.cohort, p_admin boolean) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 WITH o AS (SELECT count(*)::integer AS n FROM public.enrollment e WHERE e.cohort_id = c.id AND e.status = 'active'),
  t AS (SELECT t.id, t.name FROM public.mentor_topic mt JOIN public.topic t ON t.id = mt.topic_id WHERE mt.id = c.mentor_topic_id)
 SELECT jsonb_build_object('id', c.id::text, 'topic', jsonb_build_object('id', t.id::text, 'name', t.name), 'startsAt', internal.api_ts(c.starts_at), 'endsAt', internal.api_ts(c.ends_at),
   'timeZone', 'America/Recife', 'capacity', c.capacity, 'occupied', o.n, 'available', greatest(c.capacity - o.n, 0), 'version', c.version::text)
  || CASE WHEN p_admin THEN jsonb_build_object('mentorTopicId', c.mentor_topic_id::text, 'status', c.status) ELSE '{}'::jsonb END
 FROM o, t;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_cohort_list(p_digest text, p_mentor_topic bigint, p_after bigint, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM internal.api_mentor_read(p_digest, 'mentor_topic', p_mentor_topic);
 RETURN coalesce((SELECT jsonb_agg(internal.api_cohort_json(s.c, true) ORDER BY (s.c).id) FROM (
  SELECT c FROM public.cohort c WHERE c.mentor_topic_id = p_mentor_topic AND (p_after IS NULL OR c.id > p_after) ORDER BY c.id LIMIT internal.api_limit(p_limit)) s), '[]'::jsonb);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_cohort_get(p_digest text, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c public.cohort%ROWTYPE;
BEGIN
 PERFORM internal.api_mentor_read(p_digest, 'cohort', p_id);
 SELECT * INTO c FROM public.cohort x WHERE x.id = p_id;
 RETURN internal.api_cohort_json(c, true);
END $$;
--> statement-breakpoint
-- POST {startsAt,endsAt,capacity,status:draft|open}; início futuro, mentora/tema ativos e overlap são revalidados pelos triggers.
CREATE OR REPLACE FUNCTION internal.api_cohort_create(p_digest text, p_request uuid, p_key uuid, p_hash text, p_mentor_topic bigint, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w record; i record; c public.cohort%ROWTYPE; v_starts timestamptz; v_ends timestamptz; v_capacity integer; v_status text;
BEGIN
 SELECT * INTO w FROM internal.api_mentor_write(p_digest, p_request, 'mentor_topic', p_mentor_topic);
 SELECT * INTO i FROM internal.api_idem(w.o_actor, '/api/v1/mentor-topics/' || p_mentor_topic::text || '/cohorts', p_key, p_hash);
 IF NOT i.o_new THEN
  SELECT * INTO c FROM public.cohort x WHERE x.id = i.o_resource::bigint AND x.mentor_topic_id = p_mentor_topic;
  IF NOT FOUND THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
  RETURN internal.api_cohort_json(c, true);
 END IF;
 PERFORM internal.api_patch_keys(p_body, ARRAY['startsAt','endsAt','capacity','status']);
 v_starts := internal.api_instant(p_body -> 'startsAt', 'startsAt');
 v_ends := internal.api_instant(p_body -> 'endsAt', 'endsAt');
 v_capacity := internal.api_int(p_body -> 'capacity', 'capacity', 1, 20);
 v_status := p_body ->> 'status';
 IF jsonb_typeof(p_body -> 'status') IS DISTINCT FROM 'string' OR v_status NOT IN ('draft','open') THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['status']); END IF;
 IF v_ends <= v_starts THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['endsAt']); END IF;
 IF v_starts <= now() THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['startsAt']); END IF;
 INSERT INTO public.cohort(mentor_topic_id, starts_at, ends_at, capacity, status) VALUES (p_mentor_topic, v_starts, v_ends, v_capacity, v_status) RETURNING * INTO c;
 PERFORM internal.api_audit(w.o_actor, 'cohort.create', 'cohort', c.id::text, '["startsAt","endsAt","capacity","status"]'::jsonb, p_request);
 PERFORM internal.idem_finish(i.o_id, c.id::text, 201);
 RETURN internal.api_cohort_json(c, true);
END $$;
--> statement-breakpoint
-- PATCH {startsAt?,endsAt?,capacity?,status?} e DELETE (= cancelled, só sem reservas active). Transições/ocupação revalidadas no banco.
CREATE OR REPLACE FUNCTION internal.api_cohort_update(p_digest text, p_request uuid, p_id bigint, p_version bigint, p_patch jsonb, p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w record; c public.cohort%ROWTYPE; v_starts timestamptz; v_ends timestamptz; v_capacity integer; v_status text; v_fields text[] := ARRAY[]::text[];
BEGIN
 SELECT * INTO w FROM internal.api_mentor_write(p_digest, p_request, 'cohort', p_id);
 PERFORM internal.api_patch_keys(p_patch, ARRAY['startsAt','endsAt','capacity','status']);
 SELECT * INTO c FROM public.cohort x WHERE x.id = p_id FOR NO KEY UPDATE;
 IF c.version IS DISTINCT FROM p_version THEN PERFORM internal.api_fail('VERSION_MISMATCH'); END IF;
 v_starts := CASE WHEN p_patch ? 'startsAt' THEN internal.api_instant(p_patch -> 'startsAt', 'startsAt') ELSE c.starts_at END;
 v_ends := CASE WHEN p_patch ? 'endsAt' THEN internal.api_instant(p_patch -> 'endsAt', 'endsAt') ELSE c.ends_at END;
 v_capacity := CASE WHEN p_patch ? 'capacity' THEN internal.api_int(p_patch -> 'capacity', 'capacity', 1, 20) ELSE c.capacity END;
 v_status := c.status;
 IF p_patch ? 'status' THEN
  v_status := p_patch ->> 'status';
  IF jsonb_typeof(p_patch -> 'status') <> 'string' OR v_status NOT IN ('draft','open','closed','cancelled') THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['status']); END IF;
 END IF;
 IF v_ends <= v_starts THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['endsAt']); END IF;
 IF v_starts IS DISTINCT FROM c.starts_at THEN v_fields := array_append(v_fields, 'startsAt'); END IF;
 IF v_ends IS DISTINCT FROM c.ends_at THEN v_fields := array_append(v_fields, 'endsAt'); END IF;
 IF v_capacity IS DISTINCT FROM c.capacity::integer THEN v_fields := array_append(v_fields, 'capacity'); END IF;
 IF v_status IS DISTINCT FROM c.status THEN v_fields := array_append(v_fields, 'status'); END IF;
 IF cardinality(v_fields) = 0 THEN RETURN internal.api_cohort_json(c, true); END IF;
 UPDATE public.cohort x SET starts_at = v_starts, ends_at = v_ends, capacity = v_capacity, status = v_status WHERE x.id = p_id RETURNING * INTO c;
 PERFORM internal.api_audit(w.o_actor, CASE WHEN p_action = 'cancel' THEN 'cohort.cancel' ELSE 'cohort.update' END, 'cohort', c.id::text, to_jsonb(v_fields), p_request);
 RETURN internal.api_cohort_json(c, true);
END $$;
--> statement-breakpoint
GRANT INSERT (mentor_topic_id, starts_at, ends_at, capacity, status), UPDATE (starts_at, ends_at, capacity, status) ON public.cohort TO techwoman_owner;
GRANT USAGE ON SEQUENCE public.cohort_id_seq TO techwoman_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.api_instant(jsonb,text), internal.api_cohort_json(public.cohort,boolean), internal.api_cohort_list(text,bigint,bigint,integer), internal.api_cohort_get(text,bigint),
 internal.api_cohort_create(text,uuid,uuid,text,bigint,jsonb), internal.api_cohort_update(text,uuid,bigint,bigint,jsonb,text) FROM PUBLIC;
--> statement-breakpoint
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.api_instant(jsonb,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_cohort_json(public.cohort,boolean) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_cohort_list(text,bigint,bigint,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_cohort_get(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_cohort_create(text,uuid,uuid,text,bigint,jsonb) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_cohort_update(text,uuid,bigint,bigint,jsonb,text) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.api_cohort_list(text,bigint,bigint,integer), internal.api_cohort_get(text,bigint), internal.api_cohort_create(text,uuid,uuid,text,bigint,jsonb),
   internal.api_cohort_update(text,uuid,bigint,bigint,jsonb,text) TO techwoman_runtime;
 END IF;
END $$;
