-- WP-003 Task 2: reserva SQL coerente. Qualquer DML de enrollment (API ou SQL da editora) mantém match/job/auditoria na mesma transação.
-- Ranking idêntico ao legado (service.ts): objetivo+especialidade 3 por coincidência, interesses 2, habilidade 1, área 3; razões na mesma ordem.
CREATE OR REPLACE FUNCTION internal.agenda_ranking(p_participant bigint, p_mentor bigint, OUT o_score integer, OUT o_reasons jsonb)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE p public.participant%ROWTYPE; m public.mentor%ROWTYPE; v_objectives text[]; v_goal text[]; v_shared text[]; v_skills text[]; v_area boolean;
BEGIN
 SELECT * INTO p FROM public.participant WHERE id = p_participant;
 SELECT * INTO m FROM public.mentor WHERE id = p_mentor;
 v_objectives := CASE p.goal WHEN 'transition' THEN ARRAY['desenvolvimento','design','produto','dados'] WHEN 'growth' THEN ARRAY['produto','dados'] WHEN 'leadership' THEN ARRAY['produto','design'] ELSE ARRAY[]::text[] END;
 v_goal := ARRAY(SELECT s.v FROM jsonb_array_elements_text(m.specialties) WITH ORDINALITY s(v, n) WHERE s.v = ANY (v_objectives) AND p.interests ? s.v ORDER BY s.n);
 v_shared := ARRAY(SELECT s.v FROM jsonb_array_elements_text(m.specialties) WITH ORDINALITY s(v, n) WHERE p.interests ? s.v ORDER BY s.n);
 v_skills := ARRAY(SELECT k.v FROM jsonb_array_elements_text(p.skills) WITH ORDINALITY k(v, n)
  WHERE m.specialties ? (CASE k.v WHEN 'codigo' THEN 'desenvolvimento' WHEN 'analise' THEN 'dados' WHEN 'comunicacao' THEN 'produto' WHEN 'gestao' THEN 'design' END) ORDER BY k.n);
 v_area := coalesce(p.area, '') <> '' AND m.specialties ? p.area;
 o_score := cardinality(v_goal) * 3 + cardinality(v_shared) * 2 + cardinality(v_skills) + CASE WHEN v_area THEN 3 ELSE 0 END;
 o_reasons := to_jsonb(ARRAY(SELECT r FROM unnest(ARRAY[
   CASE WHEN v_area THEN 'Área de atuação em comum: ' || p.area || ' (+3)' END,
   CASE WHEN cardinality(v_goal) > 0 THEN 'Objetivo e especialidades: ' || array_to_string(v_goal, ', ') || ' (+' || cardinality(v_goal) * 3 || ')' END,
   CASE WHEN cardinality(v_shared) > 0 THEN 'Interesses em comum: ' || array_to_string(v_shared, ', ') || ' (+' || cardinality(v_shared) * 2 || ')' END,
   CASE WHEN cardinality(v_skills) > 0 THEN 'Habilidades relacionadas: ' || array_to_string(v_skills, ', ') || ' (+' || cardinality(v_skills) || ')' END
  ]) WITH ORDINALITY x(r, n) WHERE r IS NOT NULL ORDER BY n));
END $$;
--> statement-breakpoint
-- cancelled_at acompanha só a transição (instante do cancelamento; reativar limpa); valor enviado pelo cliente é ignorado.
CREATE OR REPLACE FUNCTION internal.enrollment_stamp() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF TG_OP = 'INSERT' OR NEW.status = 'active' THEN NEW.cancelled_at := NULL;
 ELSIF OLD.status = 'active' THEN NEW.cancelled_at := now();
 ELSE NEW.cancelled_at := OLD.cancelled_at; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
-- Inscrição nova/reativada: turma open com início futuro, participante/mentora/tema ativos e identidade reconciliada ativa.
CREATE OR REPLACE FUNCTION internal.enrollment_check_eligible(p_participant bigint, p_cohort bigint) RETURNS void
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record;
BEGIN
 SELECT co.status, co.starts_at, m.active AS mentor_active, t.active AS topic_active INTO c
  FROM public.cohort co JOIN public.mentor_topic mt ON mt.id = co.mentor_topic_id JOIN public.mentor m ON m.id = mt.mentor_id JOIN public.topic t ON t.id = mt.topic_id
  WHERE co.id = p_cohort;
 IF c.status <> 'open' THEN PERFORM internal.agenda_reject('agenda_cohort_not_open'); END IF;
 IF c.starts_at <= now() THEN PERFORM internal.agenda_reject('agenda_not_future'); END IF;
 IF NOT (c.mentor_active AND c.topic_active) OR NOT EXISTS (SELECT 1 FROM public.participant p WHERE p.id = p_participant AND p.active) THEN
  PERFORM internal.agenda_reject('agenda_inactive');
 END IF;
 IF NOT EXISTS (SELECT 1 FROM public.participant p JOIN public.app_user u ON u.id = p.user_id WHERE p.id = p_participant AND u.status = 'active') THEN
  PERFORM internal.agenda_reject('agenda_identity_required');
 END IF;
END $$;
--> statement-breakpoint
-- Efeitos AFTER ROW (depois do WITH CHECK da RLS): match current, intenção de e-mail sem payload e auditoria só com nomes de campos.
CREATE OR REPLACE FUNCTION internal.enrollment_effects() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_mentor bigint; v_user uuid; r record;
BEGIN
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
   VALUES (NULL, 'enrollment.create', 'enrollment', NEW.id::text, '["status"]'::jsonb, 'ok', gen_random_uuid());
 ELSIF OLD.status = 'active' AND NEW.status = 'cancelled' THEN
  -- Cancelar não exige turma futura; histórico permanece, confirmação ainda não enviada deixa de valer.
  UPDATE public.match SET status = 'cancelled' WHERE enrollment_id = NEW.id AND status = 'selected';
  UPDATE public.email_job SET status = 'cancelled', updated_at = now() WHERE enrollment_id = NEW.id AND kind = 'reservation' AND status IN ('queued','unconfirmed');
  INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id)
   VALUES (NULL, 'enrollment.cancel', 'enrollment', NEW.id::text, '["status"]'::jsonb, 'ok', gen_random_uuid());
 ELSIF OLD.status = 'cancelled' AND NEW.status = 'active' THEN
  PERFORM internal.enrollment_check_eligible(NEW.participant_id, NEW.cohort_id);
  SELECT p.user_id INTO v_user FROM public.participant p WHERE p.id = NEW.participant_id;
  UPDATE public.match SET status = 'selected' WHERE enrollment_id = NEW.id AND status = 'cancelled';
  INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key, participant_id, enrollment_id)
   VALUES (gen_random_uuid(), v_user, 'reservation', 0, 'queued', 'reservation:' || NEW.id::text || ':' || NEW.version::text, NEW.participant_id, NEW.id);
  INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id)
   VALUES (NULL, 'enrollment.reactivate', 'enrollment', NEW.id::text, '["status"]'::jsonb, 'ok', gen_random_uuid());
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
-- Validador integral (substitui a versão da Task 1, mesmas regras) + nenhuma participante com inscrições active sobrepostas, entre quaisquer mentoras.
CREATE OR REPLACE FUNCTION internal.validate_agenda_state() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 -- Máximo dois vínculos no total, inclusive com mentor_topic_position_unique adiado na troca de posições.
 IF EXISTS (SELECT 1 FROM public.mentor_topic GROUP BY mentor_id HAVING count(*) > 2) THEN
  RAISE EXCEPTION 'agenda_topic_limit' USING ERRCODE = 'check_violation', CONSTRAINT = 'agenda_topic_limit';
 END IF;
 IF EXISTS (
  SELECT 1 FROM public.cohort a JOIN public.mentor_topic ma ON ma.id = a.mentor_topic_id
   JOIN public.mentor_topic mb ON mb.mentor_id = ma.mentor_id
   JOIN public.cohort b ON b.mentor_topic_id = mb.id AND b.id <> a.id
  WHERE a.status <> 'cancelled' AND b.status <> 'cancelled' AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at) THEN
  RAISE EXCEPTION 'agenda_mentor_overlap' USING ERRCODE = 'check_violation', CONSTRAINT = 'agenda_mentor_overlap';
 END IF;
 IF EXISTS (
  SELECT 1 FROM public.enrollment ea JOIN public.cohort a ON a.id = ea.cohort_id
   JOIN public.enrollment eb ON eb.participant_id = ea.participant_id AND eb.id <> ea.id AND eb.status = 'active'
   JOIN public.cohort b ON b.id = eb.cohort_id
  WHERE ea.status = 'active' AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at) THEN
  RAISE EXCEPTION 'agenda_participant_overlap' USING ERRCODE = 'check_violation', CONSTRAINT = 'agenda_participant_overlap';
 END IF;
 -- Ocupação = inscrições active (match não é fonte de vagas); closed retém, cancelled exige zero.
 IF EXISTS (SELECT 1 FROM public.cohort c JOIN public.enrollment e ON e.cohort_id = c.id AND e.status = 'active' GROUP BY c.id, c.capacity HAVING count(*) > c.capacity) THEN
  RAISE EXCEPTION 'agenda_capacity_exceeded' USING ERRCODE = 'check_violation', CONSTRAINT = 'agenda_capacity_exceeded';
 END IF;
 IF EXISTS (SELECT 1 FROM public.cohort c JOIN public.enrollment e ON e.cohort_id = c.id AND e.status = 'active' WHERE c.status = 'cancelled') THEN
  RAISE EXCEPTION 'agenda_cohort_in_use' USING ERRCODE = 'check_violation', CONSTRAINT = 'agenda_cohort_in_use';
 END IF;
 -- Desativar participante, mentora ou tema com reserva active exige cancelamento explícito antes.
 IF EXISTS (SELECT 1 FROM public.enrollment e JOIN public.participant p ON p.id = e.participant_id JOIN public.cohort c ON c.id = e.cohort_id
   JOIN public.mentor_topic mt ON mt.id = c.mentor_topic_id JOIN public.mentor m ON m.id = mt.mentor_id JOIN public.topic t ON t.id = mt.topic_id
  WHERE e.status = 'active' AND NOT (p.active AND m.active AND t.active)) THEN
  RAISE EXCEPTION 'agenda_active_enrollment' USING ERRCODE = 'check_violation', CONSTRAINT = 'agenda_active_enrollment';
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.agenda_ranking(bigint, bigint), internal.enrollment_stamp(), internal.enrollment_check_eligible(bigint, bigint), internal.enrollment_effects() FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT (id, status) ON public.app_user TO techwoman_owner;
GRANT SELECT, INSERT, UPDATE (status) ON public.match TO techwoman_owner;
GRANT SELECT, INSERT, UPDATE (status, updated_at) ON public.email_job TO techwoman_owner;
GRANT INSERT ON public.audit_event TO techwoman_owner;
GRANT USAGE ON SEQUENCE public.match_id_seq, public.audit_event_id_seq TO techwoman_owner;
--> statement-breakpoint
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.agenda_ranking(bigint, bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.enrollment_stamp() OWNER TO techwoman_owner;
ALTER FUNCTION internal.enrollment_check_eligible(bigint, bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.enrollment_effects() OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
CREATE TRIGGER agenda_enrollment_stamp BEFORE INSERT OR UPDATE ON public.enrollment FOR EACH ROW EXECUTE FUNCTION internal.enrollment_stamp();
CREATE TRIGGER agenda_enrollment_effects AFTER INSERT OR UPDATE ON public.enrollment FOR EACH ROW EXECUTE FUNCTION internal.enrollment_effects();
--> statement-breakpoint
-- Match de reserva (enrollment_id) só muda pelos efeitos da inscrição (trigger aninhado); DML direto recusado para não dessincronizar.
-- Em qualquer match, id/FKs/score/reasons/origem são imutáveis; legado/sugestão sem reserva continua com status editável.
CREATE OR REPLACE FUNCTION internal.match_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF pg_catalog.pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
 IF NEW.enrollment_id IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.enrollment_id IS NOT NULL) THEN PERFORM internal.agenda_reject('agenda_match_managed'); END IF;
 IF TG_OP = 'UPDATE' AND (NEW.id, NEW.participant_id, NEW.mentor_id, NEW.score, NEW.reasons, NEW.origin) IS DISTINCT FROM (OLD.id, OLD.participant_id, OLD.mentor_id, OLD.score, OLD.reasons, OLD.origin) THEN
  PERFORM internal.agenda_reject('agenda_immutable');
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.match_guard() FROM PUBLIC;
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.match_guard() OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
CREATE TRIGGER agenda_match_guard BEFORE INSERT OR UPDATE ON public.match FOR EACH ROW EXECUTE FUNCTION internal.match_guard();
