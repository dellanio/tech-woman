-- WP-003 Task 3: cruzamentos administrativos (/admin/matches). Score/razões sempre do servidor (internal.agenda_ranking, ranking legado).
-- Match com participante OU mentora protegida é inacessível pelo CRUD comum. PATCH só sugestão current sem reserva; DELETE = cancelled
-- (legado aprovado/rejeitado preservado e consultável, sem turma inventada). Match de reserva só muda pela inscrição.
CREATE OR REPLACE FUNCTION internal.api_match_json(x public.match) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('id', x.id::text, 'participantId', x.participant_id::text, 'mentorId', x.mentor_id::text, 'score', x.score, 'reasons', x.reasons,
  'status', x.status, 'origin', x.origin, 'enrollmentId', x.enrollment_id::text, 'version', x.version::text);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_match_hidden(p_participant bigint, p_mentor bigint) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT internal.domain_protected('participant', p_participant) OR internal.domain_protected('mentor', p_mentor);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_match_list(p_digest text, p_after bigint, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 IF NOT (a.o_roles && ARRAY['admin','team']) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 RETURN coalesce((SELECT jsonb_agg(internal.api_match_json(s.x) ORDER BY (s.x).id) FROM (SELECT x FROM public.match x
  WHERE (p_after IS NULL OR x.id > p_after) AND NOT internal.api_match_hidden(x.participant_id, x.mentor_id) ORDER BY x.id LIMIT internal.api_limit(p_limit)) s), '[]'::jsonb);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_match_get(p_digest text, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; x public.match%ROWTYPE;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 SELECT * INTO x FROM public.match m WHERE m.id = p_id;
 IF NOT FOUND OR NOT (a.o_roles && ARRAY['admin','team']) OR internal.api_match_hidden(x.participant_id, x.mentor_id) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 RETURN internal.api_match_json(x);
END $$;
--> statement-breakpoint
-- POST {participantId,mentorId}: trava ator + donas das duas linhas → guard → confirma donas → protegido/inexistente/inativo = mesmo 422 por campo.
CREATE OR REPLACE FUNCTION internal.api_match_create(p_digest text, p_request uuid, p_key uuid, p_hash text, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; i record; x public.match%ROWTYPE; v_participant bigint; v_mentor bigint; v_owners uuid[]; r record;
BEGIN
 PERFORM internal.api_patch_keys(p_body, ARRAY['participantId','mentorId']);
 v_participant := internal.api_sql_id(p_body -> 'participantId', 'participantId');
 v_mentor := internal.api_sql_id(p_body -> 'mentorId', 'mentorId');
 v_owners := ARRAY(SELECT u FROM unnest(ARRAY[internal.api_domain_owner('participant', v_participant), internal.api_domain_owner('mentor', v_mentor)]) u WHERE u IS NOT NULL);
 SELECT * INTO a FROM internal.api_auth(p_digest, v_owners, p_request);
 IF NOT ('admin' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 SELECT * INTO i FROM internal.api_idem(a.o_actor, '/api/v1/admin/matches', p_key, p_hash);
 IF NOT i.o_new THEN
  SELECT * INTO x FROM public.match m WHERE m.id = i.o_resource::bigint;
  IF internal.api_match_hidden(x.participant_id, x.mentor_id) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
  RETURN internal.api_match_json(x);
 END IF;
 PERFORM internal.api_guard();
 IF ARRAY(SELECT u FROM unnest(ARRAY[internal.api_domain_owner('participant', v_participant), internal.api_domain_owner('mentor', v_mentor)]) u WHERE u IS NOT NULL) IS DISTINCT FROM v_owners THEN
  RAISE EXCEPTION 'domain owner changed' USING ERRCODE = '40001';
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.participant p WHERE p.id = v_participant AND p.active) OR internal.domain_protected('participant', v_participant) THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['participantId']); END IF;
 IF NOT EXISTS (SELECT 1 FROM public.mentor m WHERE m.id = v_mentor AND m.active) OR internal.domain_protected('mentor', v_mentor) THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['mentorId']); END IF;
 SELECT * INTO r FROM internal.agenda_ranking(v_participant, v_mentor);
 INSERT INTO public.match(participant_id, mentor_id, score, reasons, status, origin) VALUES (v_participant, v_mentor, r.o_score, r.o_reasons, 'suggested', 'current') RETURNING * INTO x;
 PERFORM internal.api_audit(a.o_actor, 'match.create', 'match', x.id::text, '["participantId","mentorId","status"]'::jsonb, p_request);
 PERFORM internal.idem_finish(i.o_id, x.id::text, 201);
 RETURN internal.api_match_json(x);
END $$;
--> statement-breakpoint
-- PATCH {status:suggested|rejected} (só sugestão current sem reserva) e DELETE (= cancelled, inclusive legado; reserva → 409).
CREATE OR REPLACE FUNCTION internal.api_match_update(p_digest text, p_request uuid, p_id bigint, p_version bigint, p_patch jsonb, p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; x public.match%ROWTYPE; v_owners uuid[]; v_status text;
BEGIN
 SELECT * INTO x FROM public.match m WHERE m.id = p_id;
 v_owners := ARRAY(SELECT u FROM unnest(ARRAY[internal.api_domain_owner('participant', x.participant_id), internal.api_domain_owner('mentor', x.mentor_id)]) u WHERE u IS NOT NULL);
 SELECT * INTO a FROM internal.api_auth(p_digest, v_owners, p_request);
 IF NOT (a.o_roles && ARRAY['admin','team']) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 PERFORM internal.api_guard();
 SELECT * INTO x FROM public.match m WHERE m.id = p_id FOR NO KEY UPDATE;
 IF NOT FOUND OR internal.api_match_hidden(x.participant_id, x.mentor_id) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 IF ARRAY(SELECT u FROM unnest(ARRAY[internal.api_domain_owner('participant', x.participant_id), internal.api_domain_owner('mentor', x.mentor_id)]) u WHERE u IS NOT NULL) IS DISTINCT FROM v_owners THEN
  RAISE EXCEPTION 'domain owner changed' USING ERRCODE = '40001';
 END IF;
 IF NOT ('admin' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 IF p_action = 'cancel' THEN v_status := 'cancelled';
 ELSE
  PERFORM internal.api_patch_keys(p_patch, ARRAY['status']);
  v_status := p_patch ->> 'status';
  IF jsonb_typeof(p_patch -> 'status') <> 'string' OR v_status NOT IN ('suggested','rejected') THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['status']); END IF;
 END IF;
 IF x.version IS DISTINCT FROM p_version THEN PERFORM internal.api_fail('VERSION_MISMATCH'); END IF;
 IF x.enrollment_id IS NOT NULL THEN PERFORM internal.api_fail('COHORT_IN_USE'); END IF;
 IF x.status = v_status THEN RETURN internal.api_match_json(x); END IF;
 IF p_action <> 'cancel' AND NOT (x.origin = 'current' AND x.status IN ('suggested','rejected')) THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['status']); END IF;
 UPDATE public.match m SET status = v_status WHERE m.id = p_id RETURNING * INTO x;
 PERFORM internal.api_audit(a.o_actor, CASE WHEN p_action = 'cancel' THEN 'match.cancel' ELSE 'match.update' END, 'match', x.id::text, '["status"]'::jsonb, p_request);
 RETURN internal.api_match_json(x);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.api_match_json(public.match), internal.api_match_hidden(bigint,bigint), internal.api_match_list(text,bigint,integer), internal.api_match_get(text,bigint),
 internal.api_match_create(text,uuid,uuid,text,jsonb), internal.api_match_update(text,uuid,bigint,bigint,jsonb,text) FROM PUBLIC;
--> statement-breakpoint
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.api_match_json(public.match) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_match_hidden(bigint,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_match_list(text,bigint,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_match_get(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_match_create(text,uuid,uuid,text,jsonb) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_match_update(text,uuid,bigint,bigint,jsonb,text) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.api_match_list(text,bigint,integer), internal.api_match_get(text,bigint), internal.api_match_create(text,uuid,uuid,text,jsonb),
   internal.api_match_update(text,uuid,bigint,bigint,jsonb,text) TO techwoman_runtime;
 END IF;
END $$;
