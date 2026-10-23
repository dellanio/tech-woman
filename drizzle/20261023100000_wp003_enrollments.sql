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
-- Efeitos AFTER ROW (depois do WITH CHECK da RLS): match current, intenção de e-mail sem payload e auditoria só com nomes de campos.
CREATE OR REPLACE FUNCTION internal.enrollment_effects() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_mentor bigint; v_user uuid; r record;
BEGIN
 IF TG_OP = 'INSERT' THEN
  SELECT mt.mentor_id INTO v_mentor FROM public.cohort c JOIN public.mentor_topic mt ON mt.id = c.mentor_topic_id WHERE c.id = NEW.cohort_id;
  SELECT p.user_id INTO v_user FROM public.participant p WHERE p.id = NEW.participant_id;
  SELECT * INTO r FROM internal.agenda_ranking(NEW.participant_id, v_mentor);
  INSERT INTO public.match(participant_id, mentor_id, score, reasons, status, origin, enrollment_id)
   VALUES (NEW.participant_id, v_mentor, r.o_score, r.o_reasons, 'selected', 'current', NEW.id);
  INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key, participant_id, enrollment_id)
   VALUES (gen_random_uuid(), v_user, 'reservation', 0, 'queued', 'reservation:' || NEW.id::text || ':' || NEW.version::text, NEW.participant_id, NEW.id);
  INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id)
   VALUES (NULL, 'enrollment.create', 'enrollment', NEW.id::text, '["status"]'::jsonb, 'ok', gen_random_uuid());
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.agenda_ranking(bigint, bigint), internal.enrollment_effects() FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT (id, status) ON public.app_user TO techwoman_owner;
GRANT SELECT, INSERT, UPDATE (status) ON public.match TO techwoman_owner;
GRANT SELECT, INSERT, UPDATE (status, updated_at) ON public.email_job TO techwoman_owner;
GRANT INSERT ON public.audit_event TO techwoman_owner;
GRANT USAGE ON SEQUENCE public.match_id_seq, public.audit_event_id_seq TO techwoman_owner;
--> statement-breakpoint
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.agenda_ranking(bigint, bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.enrollment_effects() OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
CREATE TRIGGER agenda_enrollment_effects AFTER INSERT OR UPDATE ON public.enrollment FOR EACH ROW EXECUTE FUNCTION internal.enrollment_effects();
