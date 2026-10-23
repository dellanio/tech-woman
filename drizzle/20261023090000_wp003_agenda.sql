-- WP-003 Task 1: guard global de Agenda, transições/imutabilidade e validação integral por statement.
-- Ordem de locks: app_user (API, em ordem de UUID) -> internal.agenda_guard -> domínio. SQL direto da editora começa pelo guard.
-- Escrita real da revisão (não só FOR UPDATE): snapshot REPEATABLE READ/SERIALIZABLE obsoleto falha com 40001.
CREATE OR REPLACE FUNCTION internal.acquire_agenda_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 UPDATE internal.agenda_guard SET revision = revision + 1 WHERE id = 1;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.acquire_agenda_guard() FROM PUBLIC;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['topic','mentor_topic','cohort','enrollment','mentor','participant'] LOOP
  EXECUTE format('CREATE TRIGGER agenda_guard BEFORE INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION internal.acquire_agenda_guard()', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Validação integral pós-DML: consultas novas (VOLATILE, nunca STABLE) depois do guard; mensagens sem IDs para não revelar linhas ocultas.
-- Intervalo [início,fim): a.starts_at < b.ends_at AND b.starts_at < a.ends_at; contíguo é válido.
CREATE OR REPLACE FUNCTION internal.validate_agenda_state() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM public.cohort a JOIN public.mentor_topic ma ON ma.id = a.mentor_topic_id
   JOIN public.mentor_topic mb ON mb.mentor_id = ma.mentor_id
   JOIN public.cohort b ON b.mentor_topic_id = mb.id AND b.id <> a.id
  WHERE a.status <> 'cancelled' AND b.status <> 'cancelled' AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at) THEN
  RAISE EXCEPTION 'agenda_mentor_overlap' USING ERRCODE = 'check_violation', CONSTRAINT = 'agenda_mentor_overlap';
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.validate_agenda_state() FROM PUBLIC;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['topic','mentor_topic','cohort','enrollment','mentor','participant'] LOOP
  EXECUTE format('CREATE TRIGGER agenda_validate AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION internal.validate_agenda_state()', t);
 END LOOP;
END $$;
