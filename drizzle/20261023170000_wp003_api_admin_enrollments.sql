-- WP-003 Task 4: inscrições administrativas (/admin/enrollments). Ocultas se a participante OU a mentora da turma for protegida.
-- DELETE = cancelar com If-Match (idempotente). Realocação: cancela a origem + cria a nova (efeitos T2: match/job/auditoria com ator) numa
-- única transação; qualquer falha no destino desfaz tudo e a reserva original continua ativa.
CREATE OR REPLACE FUNCTION internal.api_admin_enrollment_json(e public.enrollment) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT internal.api_enrollment_json(e) || jsonb_build_object('participantId', e.participant_id::text,
  'cancelledAt', CASE WHEN e.cancelled_at IS NULL THEN NULL ELSE internal.api_ts(e.cancelled_at) END, 'version', e.version::text);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_enrollment_hidden(p_participant bigint, p_cohort bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT internal.domain_protected('participant', p_participant) OR internal.domain_protected('mentor', internal.api_mentor_of('cohort', p_cohort));
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_admin_enrollment_list(p_digest text, p_after bigint, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 IF NOT (a.o_roles && ARRAY['admin','team']) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 RETURN coalesce((SELECT jsonb_agg(internal.api_admin_enrollment_json(s.e) ORDER BY (s.e).id) FROM (SELECT e FROM public.enrollment e
  WHERE (p_after IS NULL OR e.id > p_after) AND NOT internal.api_enrollment_hidden(e.participant_id, e.cohort_id) ORDER BY e.id LIMIT internal.api_limit(p_limit)) s), '[]'::jsonb);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_admin_enrollment_get(p_digest text, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; e public.enrollment%ROWTYPE;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 SELECT * INTO e FROM public.enrollment x WHERE x.id = p_id;
 IF NOT FOUND OR NOT (a.o_roles && ARRAY['admin','team']) OR internal.api_enrollment_hidden(e.participant_id, e.cohort_id) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 RETURN internal.api_admin_enrollment_json(e);
END $$;
--> statement-breakpoint
-- Escrita sobre uma inscrição: trava ator + conta da participante (UUID) → guard → confirma dona → proteção sob lock → participante e inscrição (ID).
CREATE OR REPLACE FUNCTION internal.api_admin_enrollment_write(p_digest text, p_request uuid, p_id bigint, OUT o_actor uuid, OUT o_enrollment public.enrollment)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; v_participant bigint; v_owner uuid;
BEGIN
 SELECT x.participant_id INTO v_participant FROM public.enrollment x WHERE x.id = p_id;
 v_owner := internal.api_domain_owner('participant', v_participant);
 SELECT * INTO a FROM internal.api_auth(p_digest, CASE WHEN v_owner IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_owner] END, p_request);
 IF NOT (a.o_roles && ARRAY['admin','team']) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 PERFORM internal.api_guard();
 IF internal.api_domain_owner('participant', v_participant) IS DISTINCT FROM v_owner THEN RAISE EXCEPTION 'domain owner changed' USING ERRCODE = '40001'; END IF;
 PERFORM 1 FROM public.participant p WHERE p.id = v_participant FOR NO KEY UPDATE;
 SELECT * INTO o_enrollment FROM public.enrollment x WHERE x.id = p_id FOR NO KEY UPDATE;
 IF o_enrollment.id IS NULL OR internal.api_enrollment_hidden(o_enrollment.participant_id, o_enrollment.cohort_id) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 IF NOT ('admin' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 o_actor := a.o_actor;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_admin_enrollment_cancel(p_digest text, p_request uuid, p_id bigint, p_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w record; e public.enrollment%ROWTYPE;
BEGIN
 SELECT * INTO w FROM internal.api_admin_enrollment_write(p_digest, p_request, p_id);
 e := w.o_enrollment;
 IF e.version IS DISTINCT FROM p_version THEN PERFORM internal.api_fail('VERSION_MISMATCH'); END IF;
 IF e.status = 'active' THEN UPDATE public.enrollment x SET status = 'cancelled' WHERE x.id = p_id RETURNING * INTO e; END IF;
 RETURN internal.api_admin_enrollment_json(e);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_admin_enrollment_reassign(p_digest text, p_request uuid, p_key uuid, p_hash text, p_id bigint, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w record; i record; e public.enrollment%ROWTYPE; n public.enrollment%ROWTYPE; v_cohort bigint; c record;
BEGIN
 SELECT * INTO w FROM internal.api_admin_enrollment_write(p_digest, p_request, p_id);
 e := w.o_enrollment;
 SELECT * INTO i FROM internal.api_idem(w.o_actor, '/api/v1/admin/enrollments/' || p_id::text || '/reassign', p_key, p_hash);
 IF NOT i.o_new THEN SELECT * INTO n FROM public.enrollment x WHERE x.id = i.o_resource::bigint; RETURN internal.api_admin_enrollment_json(n); END IF;
 PERFORM internal.api_patch_keys(p_body, ARRAY['cohortId','confirm']);
 IF p_body -> 'confirm' IS DISTINCT FROM 'true'::jsonb THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['confirm']); END IF;
 v_cohort := internal.api_sql_id(p_body -> 'cohortId', 'cohortId');
 IF e.status <> 'active' THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['status']); END IF;
 IF v_cohort = e.cohort_id THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['cohortId']); END IF;
 PERFORM 1 FROM public.cohort x WHERE x.id IN (e.cohort_id, v_cohort) ORDER BY x.id FOR NO KEY UPDATE;
 SELECT co.status, co.starts_at, co.capacity, m.active AND t.active AS domain_active, mt.mentor_id,
   (SELECT count(*) FROM public.enrollment x WHERE x.cohort_id = co.id AND x.status = 'active') AS occupied
  INTO c FROM public.cohort co JOIN public.mentor_topic mt ON mt.id = co.mentor_topic_id JOIN public.mentor m ON m.id = mt.mentor_id JOIN public.topic t ON t.id = mt.topic_id
  WHERE co.id = v_cohort;
 IF NOT FOUND OR internal.domain_protected('mentor', c.mentor_id) THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['cohortId']); END IF;
 IF EXISTS (SELECT 1 FROM public.enrollment x WHERE x.participant_id = e.participant_id AND x.cohort_id = v_cohort AND x.status = 'active') THEN PERFORM internal.api_fail('ALREADY_ENROLLED'); END IF;
 IF c.status <> 'open' OR c.starts_at <= now() OR NOT c.domain_active THEN PERFORM internal.api_fail('COHORT_NOT_OPEN'); END IF;
 IF c.occupied >= c.capacity THEN PERFORM internal.api_fail('COHORT_FULL'); END IF;
 UPDATE public.enrollment x SET status = 'cancelled' WHERE x.id = e.id;
 INSERT INTO public.enrollment(participant_id, cohort_id, status) VALUES (e.participant_id, v_cohort, 'active') RETURNING * INTO n;
 PERFORM internal.api_audit(w.o_actor, 'enrollment.reassign', 'enrollment', e.id::text, '["cohortId"]'::jsonb, p_request);
 PERFORM internal.idem_finish(i.o_id, n.id::text, 201);
 RETURN internal.api_admin_enrollment_json(n);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.api_admin_enrollment_json(public.enrollment), internal.api_enrollment_hidden(bigint,bigint), internal.api_admin_enrollment_list(text,bigint,integer),
 internal.api_admin_enrollment_get(text,bigint), internal.api_admin_enrollment_write(text,uuid,bigint), internal.api_admin_enrollment_cancel(text,uuid,bigint,bigint),
 internal.api_admin_enrollment_reassign(text,uuid,uuid,text,bigint,jsonb) FROM PUBLIC;
--> statement-breakpoint
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.api_admin_enrollment_json(public.enrollment) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_enrollment_hidden(bigint,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_admin_enrollment_list(text,bigint,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_admin_enrollment_get(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_admin_enrollment_write(text,uuid,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_admin_enrollment_cancel(text,uuid,bigint,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_admin_enrollment_reassign(text,uuid,uuid,text,bigint,jsonb) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.api_admin_enrollment_list(text,bigint,integer), internal.api_admin_enrollment_get(text,bigint), internal.api_admin_enrollment_cancel(text,uuid,bigint,bigint),
   internal.api_admin_enrollment_reassign(text,uuid,uuid,text,bigint,jsonb) TO techwoman_runtime;
 END IF;
END $$;
