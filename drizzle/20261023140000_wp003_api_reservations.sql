-- WP-003 Task 4: catálogo de escolha, recomendações e reserva própria.
-- Catálogo/recomendação: só projeção pública da mentora (sem e-mail/conta/papéis), inclusive de mentora protegida. Reserva: participante obtida da
-- sessão (nunca do corpo), score0 aceito sem aprovação; match/job/auditoria vêm dos efeitos SQL da T2, agora com o ator confiável da transação.

-- Efeitos da inscrição (T2) com ator/requisição do contexto autenticado; SQL direto da editora segue com ator NULL (sem contexto).
CREATE OR REPLACE FUNCTION internal.enrollment_effects() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_mentor bigint; v_user uuid; r record; v_actor uuid; v_request uuid;
BEGIN
 SELECT c.actor, c.request INTO v_actor, v_request FROM internal.api_context c WHERE c.xact = pg_catalog.pg_current_xact_id();
 IF TG_OP = 'INSERT' THEN
  IF NEW.status <> 'active' THEN PERFORM internal.agenda_reject('agenda_invalid_transition'); END IF;
  PERFORM internal.enrollment_check_eligible(NEW.participant_id, NEW.cohort_id);
  SELECT mt.mentor_id INTO v_mentor FROM public.cohort c JOIN public.mentor_topic mt ON mt.id = c.mentor_topic_id WHERE c.id = NEW.cohort_id;
  SELECT p.user_id INTO v_user FROM public.participant p WHERE p.id = NEW.participant_id;
  SELECT * INTO r FROM internal.agenda_ranking(NEW.participant_id, v_mentor);
  INSERT INTO public.match(participant_id, mentor_id, score, reasons, status, origin, enrollment_id)
   VALUES (NEW.participant_id, v_mentor, r.o_score, r.o_reasons, 'selected', 'current', NEW.id);
  INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key, participant_id, enrollment_id)
   VALUES (gen_random_uuid(), v_user, 'reservation', 0, 'queued', 'reservation:' || NEW.id::text || ':' || NEW.version::text, NEW.participant_id, NEW.id);
  INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id)
   VALUES (v_actor, 'enrollment.create', 'enrollment', NEW.id::text, '["status"]'::jsonb, 'ok', coalesce(v_request, gen_random_uuid()));
 ELSIF OLD.status = 'active' AND NEW.status = 'cancelled' THEN
  UPDATE public.match SET status = 'cancelled' WHERE enrollment_id = NEW.id AND status = 'selected';
  UPDATE public.email_job SET status = 'cancelled', updated_at = now() WHERE enrollment_id = NEW.id AND kind = 'reservation' AND status IN ('queued','unconfirmed');
  INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id)
   VALUES (v_actor, 'enrollment.cancel', 'enrollment', NEW.id::text, '["status"]'::jsonb, 'ok', coalesce(v_request, gen_random_uuid()));
 ELSIF OLD.status = 'cancelled' AND NEW.status = 'active' THEN
  PERFORM internal.enrollment_check_eligible(NEW.participant_id, NEW.cohort_id);
  SELECT p.user_id INTO v_user FROM public.participant p WHERE p.id = NEW.participant_id;
  UPDATE public.match SET status = 'selected' WHERE enrollment_id = NEW.id AND status = 'cancelled';
  INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key, participant_id, enrollment_id)
   VALUES (gen_random_uuid(), v_user, 'reservation', 0, 'queued', 'reservation:' || NEW.id::text || ':' || NEW.version::text, NEW.participant_id, NEW.id);
  INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id)
   VALUES (v_actor, 'enrollment.reactivate', 'enrollment', NEW.id::text, '["status"]'::jsonb, 'ok', coalesce(v_request, gen_random_uuid()));
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
-- Elegível: mentora ativa com ao menos uma turma open futura com vaga, de tema ativo.
CREATE OR REPLACE FUNCTION internal.api_mentor_eligible(p_mentor bigint) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM public.mentor m JOIN public.mentor_topic mt ON mt.mentor_id = m.id JOIN public.topic t ON t.id = mt.topic_id JOIN public.cohort c ON c.mentor_topic_id = mt.id
  WHERE m.id = p_mentor AND m.active AND t.active AND c.status = 'open' AND c.starts_at > now()
   AND (SELECT count(*) FROM public.enrollment e WHERE e.cohort_id = c.id AND e.status = 'active') < c.capacity);
$$;
--> statement-breakpoint
-- Projeção pública da mentora: nunca e-mail, user_id ou papéis; nome de exibição com fallback.
CREATE OR REPLACE FUNCTION internal.api_mentor_choice_json(m public.mentor) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('id', m.id::text,
  'displayName', coalesce(nullif(btrim(m.display_name), ''), CASE WHEN m.demo THEN nullif(btrim(m.demo_name), '') END, 'Mentora #' || m.id::text),
  'demo', m.demo, 'trajectory', m.trajectory, 'specialties', m.specialties);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_catalog_actor(p_digest text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 IF NOT (a.o_roles && ARRAY['participant','mentor','admin']) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_catalog_mentors(p_digest text, p_after bigint, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM internal.api_catalog_actor(p_digest);
 RETURN coalesce((SELECT jsonb_agg(internal.api_mentor_choice_json(s.m) ORDER BY (s.m).id) FROM (
  SELECT m FROM public.mentor m WHERE (p_after IS NULL OR m.id > p_after) AND internal.api_mentor_eligible(m.id) ORDER BY m.id LIMIT internal.api_limit(p_limit)) s), '[]'::jsonb);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_catalog_mentor(p_digest text, p_mentor bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE m public.mentor%ROWTYPE;
BEGIN
 PERFORM internal.api_catalog_actor(p_digest);
 SELECT * INTO m FROM public.mentor x WHERE x.id = p_mentor;
 IF NOT FOUND OR NOT internal.api_mentor_eligible(p_mentor) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 RETURN internal.api_mentor_choice_json(m);
END $$;
--> statement-breakpoint
-- Turmas escolhíveis de uma mentora ativa: open, futuras, tema ativo (vaga é informativa; o POST revalida).
CREATE OR REPLACE FUNCTION internal.api_catalog_cohorts(p_digest text, p_mentor bigint, p_after bigint, p_limit integer) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM internal.api_catalog_actor(p_digest);
 IF NOT EXISTS (SELECT 1 FROM public.mentor m WHERE m.id = p_mentor AND m.active) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 RETURN coalesce((SELECT jsonb_agg(internal.api_cohort_json(s.c, false) ORDER BY (s.c).id) FROM (
  SELECT c FROM public.cohort c JOIN public.mentor_topic mt ON mt.id = c.mentor_topic_id JOIN public.topic t ON t.id = mt.topic_id
   WHERE mt.mentor_id = p_mentor AND t.active AND c.status = 'open' AND c.starts_at > now() AND (p_after IS NULL OR c.id > p_after)
   ORDER BY c.id LIMIT internal.api_limit(p_limit)) s), '[]'::jsonb);
END $$;
--> statement-breakpoint
-- Participante reconciliada da própria sessão (nunca por parâmetro do cliente).
CREATE OR REPLACE FUNCTION internal.api_own_participant(p_actor uuid, p_roles text[]) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id bigint;
BEGIN
 IF NOT ('participant' = ANY (p_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 SELECT p.id INTO v_id FROM public.participant p WHERE p.user_id = p_actor AND p.active;
 IF v_id IS NULL THEN PERFORM internal.api_fail('IDENTITY_RECONCILIATION_REQUIRED'); END IF;
 RETURN v_id;
END $$;
--> statement-breakpoint
-- Ranking integral (legado, internal.agenda_ranking) das mentoras elegíveis: score desc, empate por mentorId; o serviço pagina e separa suggested/others.
CREATE OR REPLACE FUNCTION internal.api_recommendations(p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; v_participant bigint;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 v_participant := internal.api_own_participant(a.o_actor, a.o_roles);
 RETURN coalesce((SELECT jsonb_agg(internal.api_mentor_choice_json(s.m) || jsonb_build_object('score', (s.r).o_score, 'reasons', (s.r).o_reasons) ORDER BY (s.r).o_score DESC, (s.m).id) FROM (
  SELECT m, internal.agenda_ranking(v_participant, m.id) AS r FROM public.mentor m WHERE internal.api_mentor_eligible(m.id)) s), '[]'::jsonb);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_enrollment_json(e public.enrollment) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('id', e.id::text, 'cohortId', e.cohort_id::text, 'status', e.status, 'startsAt', internal.api_ts(c.starts_at), 'endsAt', internal.api_ts(c.ends_at))
 FROM public.cohort c WHERE c.id = e.cohort_id;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_my_enrollments(p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; v_participant bigint;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 v_participant := internal.api_own_participant(a.o_actor, a.o_roles);
 RETURN jsonb_build_object(
  'enrollments', coalesce((SELECT jsonb_agg(internal.api_enrollment_json(e) || jsonb_build_object(
     'mentor', jsonb_build_object('id', m.id::text, 'displayName', internal.api_mentor_choice_json(m) ->> 'displayName'), 'topic', jsonb_build_object('id', t.id::text, 'name', t.name)) ORDER BY e.id)
    FROM public.enrollment e JOIN public.cohort c ON c.id = e.cohort_id JOIN public.mentor_topic mt ON mt.id = c.mentor_topic_id JOIN public.mentor m ON m.id = mt.mentor_id JOIN public.topic t ON t.id = mt.topic_id
    WHERE e.participant_id = v_participant), '[]'::jsonb),
  'legacyMatches', coalesce((SELECT jsonb_agg(jsonb_build_object('id', x.id::text, 'mentorId', x.mentor_id::text, 'status', x.status, 'origin', 'legacy', 'enrollmentId', NULL) ORDER BY x.id)
    FROM public.match x WHERE x.participant_id = v_participant AND x.origin = 'legacy'), '[]'::jsonb));
END $$;
--> statement-breakpoint
-- Reserva: ator (lock) → idempotência → guard → participante → turma (ordem de ID) → elegibilidade → INSERT (efeitos T2) → idem_finish. Tudo um commit.
CREATE OR REPLACE FUNCTION internal.api_enroll(p_digest text, p_request uuid, p_key uuid, p_hash text, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; i record; e public.enrollment%ROWTYPE; v_participant bigint; v_cohort bigint; c record;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, ARRAY[]::uuid[], p_request);
 IF NOT ('participant' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 SELECT * INTO i FROM internal.api_idem(a.o_actor, '/api/v1/me/enrollments', p_key, p_hash);
 IF NOT i.o_new THEN
  SELECT x.* INTO e FROM public.enrollment x JOIN public.participant p ON p.id = x.participant_id WHERE x.id = i.o_resource::bigint AND p.user_id = a.o_actor;
  IF NOT FOUND THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
  RETURN internal.api_enrollment_json(e);
 END IF;
 PERFORM internal.api_patch_keys(p_body, ARRAY['cohortId']);
 v_cohort := internal.api_sql_id(p_body -> 'cohortId', 'cohortId');
 PERFORM internal.api_guard();
 SELECT p.id INTO v_participant FROM public.participant p WHERE p.user_id = a.o_actor AND p.active FOR NO KEY UPDATE;
 IF v_participant IS NULL THEN PERFORM internal.api_fail('IDENTITY_RECONCILIATION_REQUIRED'); END IF;
 PERFORM 1 FROM public.cohort x WHERE x.id = v_cohort FOR NO KEY UPDATE;
 SELECT co.status, co.starts_at, co.capacity, m.active AND t.active AS domain_active,
   (SELECT count(*) FROM public.enrollment x WHERE x.cohort_id = co.id AND x.status = 'active') AS occupied
  INTO c FROM public.cohort co JOIN public.mentor_topic mt ON mt.id = co.mentor_topic_id JOIN public.mentor m ON m.id = mt.mentor_id JOIN public.topic t ON t.id = mt.topic_id
  WHERE co.id = v_cohort;
 IF NOT FOUND THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['cohortId']); END IF;
 IF EXISTS (SELECT 1 FROM public.enrollment x WHERE x.participant_id = v_participant AND x.cohort_id = v_cohort AND x.status = 'active') THEN PERFORM internal.api_fail('ALREADY_ENROLLED'); END IF;
 IF c.status <> 'open' OR c.starts_at <= now() OR NOT c.domain_active THEN PERFORM internal.api_fail('COHORT_NOT_OPEN'); END IF;
 IF c.occupied >= c.capacity THEN PERFORM internal.api_fail('COHORT_FULL'); END IF;
 INSERT INTO public.enrollment(participant_id, cohort_id, status) VALUES (v_participant, v_cohort, 'active') RETURNING * INTO e;
 PERFORM internal.idem_finish(i.o_id, e.id::text, 201);
 RETURN internal.api_enrollment_json(e);
END $$;
--> statement-breakpoint
-- Cancelar a PRÓPRIA reserva (inclusive após o início); já cancelada → mesmo resultado. Alheia/inexistente → 404 idêntico.
CREATE OR REPLACE FUNCTION internal.api_my_enrollment_cancel(p_digest text, p_request uuid, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; e public.enrollment%ROWTYPE; v_participant bigint;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, ARRAY[]::uuid[], p_request);
 IF NOT ('participant' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 PERFORM internal.api_guard();
 SELECT p.id INTO v_participant FROM public.participant p WHERE p.user_id = a.o_actor FOR NO KEY UPDATE;
 SELECT * INTO e FROM public.enrollment x WHERE x.id = p_id AND x.participant_id = v_participant FOR NO KEY UPDATE;
 IF v_participant IS NULL OR NOT FOUND THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 IF e.status = 'active' THEN UPDATE public.enrollment x SET status = 'cancelled' WHERE x.id = p_id RETURNING * INTO e; END IF;
 RETURN internal.api_enrollment_json(e);
END $$;
--> statement-breakpoint
GRANT INSERT (participant_id, cohort_id, status), UPDATE (status) ON public.enrollment TO techwoman_owner;
GRANT USAGE ON SEQUENCE public.enrollment_id_seq TO techwoman_owner;
GRANT UPDATE (goal, moment, interests, skills, area, active) ON public.participant TO techwoman_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.api_mentor_eligible(bigint), internal.api_mentor_choice_json(public.mentor), internal.api_catalog_actor(text), internal.api_catalog_mentors(text,bigint,integer),
 internal.api_catalog_mentor(text,bigint), internal.api_catalog_cohorts(text,bigint,bigint,integer), internal.api_own_participant(uuid,text[]), internal.api_recommendations(text),
 internal.api_enrollment_json(public.enrollment), internal.api_my_enrollments(text), internal.api_enroll(text,uuid,uuid,text,jsonb), internal.api_my_enrollment_cancel(text,uuid,bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_eligible(bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_choice_json(public.mentor) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_catalog_actor(text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_catalog_mentors(text,bigint,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_catalog_mentor(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_catalog_cohorts(text,bigint,bigint,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_own_participant(uuid,text[]) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_recommendations(text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_enrollment_json(public.enrollment) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_my_enrollments(text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_enroll(text,uuid,uuid,text,jsonb) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_my_enrollment_cancel(text,uuid,bigint) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.api_catalog_mentors(text,bigint,integer), internal.api_catalog_mentor(text,bigint), internal.api_catalog_cohorts(text,bigint,bigint,integer),
   internal.api_recommendations(text), internal.api_my_enrollments(text), internal.api_enroll(text,uuid,uuid,text,jsonb), internal.api_my_enrollment_cancel(text,uuid,bigint) TO techwoman_runtime;
 END IF;
END $$;
