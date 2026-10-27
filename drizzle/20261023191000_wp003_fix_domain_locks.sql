-- WP-003 correção final I1/M1: as escritas v1 sobre linhas de domínio travam o MESMO conjunto do protocolo R3 (WP-002) e dos adaptadores T5:
-- ator + contas que decidem a proteção das linhas citadas (dona vinculada E contas com a mesma chave de e-mail, internal.domain_lock_users),
-- FOR NO KEY UPDATE em ordem de UUID → guard → reconferência do conjunto (mudou = 40001, retry integral) → proteção (404/422) ANTES da ação.
-- Assim a elevação offline (FOR UPDATE da conta) e a escrita se serializam também para candidato com user_id NULL. Sem inferir posse/papel.
CREATE OR REPLACE FUNCTION internal.api_domain_write(p_digest text, p_request uuid, p_participants bigint[], p_mentors bigint[], OUT o_actor uuid, OUT o_roles text[])
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; v_owners uuid[];
BEGIN
 v_owners := internal.api_legacy_owners(coalesce(p_participants, ARRAY[]::bigint[]), coalesce(p_mentors, ARRAY[]::bigint[]));
 SELECT * INTO a FROM internal.api_auth(p_digest, v_owners, p_request);
 PERFORM internal.api_guard();
 IF internal.api_legacy_owners(coalesce(p_participants, ARRAY[]::bigint[]), coalesce(p_mentors, ARRAY[]::bigint[])) IS DISTINCT FROM v_owners THEN
  RAISE EXCEPTION 'domain owner changed' USING ERRCODE = '40001';
 END IF;
 o_actor := a.o_actor; o_roles := a.o_roles;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_admin_domain_update(p_digest text, p_request uuid, p_kind text, p_id bigint, p_version bigint, p_patch jsonb, p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; f record; v_version bigint; v_changed text[] := ARRAY[]::text[]; p public.participant%ROWTYPE; m public.mentor%ROWTYPE;
BEGIN
 IF p_kind NOT IN ('participant','mentor') THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 SELECT * INTO a FROM internal.api_domain_write(p_digest, p_request, CASE WHEN p_kind = 'participant' THEN ARRAY[p_id] END, CASE WHEN p_kind = 'mentor' THEN ARRAY[p_id] END);
 IF NOT (a.o_roles && ARRAY['admin','team']) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
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
-- Temas/turmas da mentora: conjunto da mentora dona da linha; a mentora da linha não muda durante a espera (senão 40001).
CREATE OR REPLACE FUNCTION internal.api_mentor_write(p_digest text, p_request uuid, p_kind text, p_id bigint, OUT o_actor uuid, OUT o_roles text[], OUT o_mentor bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record;
BEGIN
 o_mentor := internal.api_mentor_of(p_kind, p_id);
 SELECT * INTO a FROM internal.api_domain_write(p_digest, p_request, ARRAY[]::bigint[], ARRAY[o_mentor]);
 o_actor := a.o_actor; o_roles := a.o_roles;
 IF internal.api_mentor_of(p_kind, p_id) IS DISTINCT FROM o_mentor THEN RAISE EXCEPTION 'agenda owner changed' USING ERRCODE = '40001'; END IF;
 IF o_mentor IS NULL THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 PERFORM internal.api_mentor_scope(o_actor, o_roles, o_mentor, true);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_match_create(p_digest text, p_request uuid, p_key uuid, p_hash text, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; i record; x public.match%ROWTYPE; v_participant bigint; v_mentor bigint; r record;
BEGIN
 PERFORM internal.api_patch_keys(p_body, ARRAY['participantId','mentorId']);
 v_participant := internal.api_sql_id(p_body -> 'participantId', 'participantId');
 v_mentor := internal.api_sql_id(p_body -> 'mentorId', 'mentorId');
 SELECT * INTO a FROM internal.api_domain_write(p_digest, p_request, ARRAY[v_participant], ARRAY[v_mentor]);
 IF NOT ('admin' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 SELECT * INTO i FROM internal.api_idem(a.o_actor, '/api/v1/admin/matches', p_key, p_hash);
 IF NOT i.o_new THEN
  SELECT * INTO x FROM public.match m WHERE m.id = i.o_resource::bigint;
  IF internal.api_match_hidden(x.participant_id, x.mentor_id) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
  RETURN internal.api_match_json(x);
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
CREATE OR REPLACE FUNCTION internal.api_match_update(p_digest text, p_request uuid, p_id bigint, p_version bigint, p_patch jsonb, p_action text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; x public.match%ROWTYPE; v_participant bigint; v_mentor bigint; v_status text;
BEGIN
 SELECT m.participant_id, m.mentor_id INTO v_participant, v_mentor FROM public.match m WHERE m.id = p_id;
 SELECT * INTO a FROM internal.api_domain_write(p_digest, p_request, ARRAY[v_participant], ARRAY[v_mentor]);
 IF NOT (a.o_roles && ARRAY['admin','team']) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 SELECT * INTO x FROM public.match m WHERE m.id = p_id FOR NO KEY UPDATE;
 IF NOT FOUND OR internal.api_match_hidden(x.participant_id, x.mentor_id) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 IF (x.participant_id, x.mentor_id) IS DISTINCT FROM (v_participant, v_mentor) THEN RAISE EXCEPTION 'match owner changed' USING ERRCODE = '40001'; END IF;
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
-- Inscrição: conjunto da participante E da mentora da turma (a ocultação depende das duas) e, na realocação, da mentora da turma de destino.
CREATE OR REPLACE FUNCTION internal.api_admin_enrollment_write(p_digest text, p_request uuid, p_id bigint, p_destination bigint, OUT o_actor uuid, OUT o_enrollment public.enrollment)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; v_participant bigint; v_cohort bigint;
BEGIN
 SELECT x.participant_id, x.cohort_id INTO v_participant, v_cohort FROM public.enrollment x WHERE x.id = p_id;
 SELECT * INTO a FROM internal.api_domain_write(p_digest, p_request, ARRAY[v_participant],
  ARRAY[internal.api_mentor_of('cohort', v_cohort), internal.api_mentor_of('cohort', p_destination)]);
 IF NOT (a.o_roles && ARRAY['admin','team']) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
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
 SELECT * INTO w FROM internal.api_admin_enrollment_write(p_digest, p_request, p_id, NULL::bigint);
 e := w.o_enrollment;
 IF e.version IS DISTINCT FROM p_version THEN PERFORM internal.api_fail('VERSION_MISMATCH'); END IF;
 IF e.status = 'active' THEN UPDATE public.enrollment x SET status = 'cancelled' WHERE x.id = p_id RETURNING * INTO e; END IF;
 RETURN internal.api_admin_enrollment_json(e);
END $$;
--> statement-breakpoint
-- M1: o destino entra no conjunto travado (cohortId do corpo; replay tem o mesmo corpo) e o replay reconfere a ocultação da inscrição de destino
-- (participante E mentora da turma de destino): recurso que virou protegido → 404, sem mutação.
CREATE OR REPLACE FUNCTION internal.api_admin_enrollment_reassign(p_digest text, p_request uuid, p_key uuid, p_hash text, p_id bigint, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w record; i record; e public.enrollment%ROWTYPE; n public.enrollment%ROWTYPE; v_cohort bigint; v_destination bigint; c record;
BEGIN
 -- leitura tolerante só para compor o conjunto travado; a validação do corpo continua abaixo, na mesma ordem de antes
 v_destination := CASE WHEN jsonb_typeof(p_body -> 'cohortId') = 'string' AND (p_body ->> 'cohortId') ~ '^[1-9][0-9]{0,18}$'
  THEN CASE WHEN (p_body ->> 'cohortId')::numeric <= 9223372036854775807 THEN (p_body ->> 'cohortId')::bigint END END;
 SELECT * INTO w FROM internal.api_admin_enrollment_write(p_digest, p_request, p_id, v_destination);
 e := w.o_enrollment;
 SELECT * INTO i FROM internal.api_idem(w.o_actor, '/api/v1/admin/enrollments/' || p_id::text || '/reassign', p_key, p_hash);
 IF NOT i.o_new THEN
  SELECT * INTO n FROM public.enrollment x WHERE x.id = i.o_resource::bigint;
  IF NOT FOUND OR internal.api_enrollment_hidden(n.participant_id, n.cohort_id) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
  RETURN internal.api_admin_enrollment_json(n);
 END IF;
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
-- O helper antigo (só a conta da participante) deixa de existir: nenhuma operação pode voltar a usá-lo.
DROP FUNCTION internal.api_admin_enrollment_write(text,uuid,bigint);
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.api_domain_write(text,uuid,bigint[],bigint[]), internal.api_admin_enrollment_write(text,uuid,bigint,bigint) FROM PUBLIC;
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.api_domain_write(text,uuid,bigint[],bigint[]) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_admin_enrollment_write(text,uuid,bigint,bigint) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
