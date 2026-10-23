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
