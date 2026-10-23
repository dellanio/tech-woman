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
REVOKE ALL ON FUNCTION internal.validate_agenda_state() FROM PUBLIC;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['topic','mentor_topic','cohort','enrollment','mentor','participant'] LOOP
  EXECUTE format('CREATE TRIGGER agenda_validate AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH STATEMENT EXECUTE FUNCTION internal.validate_agenda_state()', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Recusa com nome estável (mapeado pelo serviço via constraint); sem dados da linha na mensagem.
CREATE OR REPLACE FUNCTION internal.agenda_reject(p_name text) RETURNS void
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN RAISE EXCEPTION '%', p_name USING ERRCODE = 'check_violation', CONSTRAINT = p_name; END $$;
--> statement-breakpoint
-- BEFORE ROW (depois do guard do statement): imutabilidade de id/FK/slug e transições exatas de cohort.
-- Exigência de início futuro só na criação, reabertura e mudança de horário; cancelar após o início é permitido.
CREATE OR REPLACE FUNCTION internal.agenda_row_check() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND NEW.id IS DISTINCT FROM OLD.id THEN PERFORM internal.agenda_reject('agenda_immutable'); END IF;
 IF TG_TABLE_NAME = 'topic' THEN
  IF TG_OP = 'UPDATE' AND NEW.slug IS DISTINCT FROM OLD.slug THEN PERFORM internal.agenda_reject('agenda_immutable'); END IF;
 ELSIF TG_TABLE_NAME = 'mentor_topic' AND TG_OP = 'UPDATE' THEN
  IF NEW.mentor_id IS DISTINCT FROM OLD.mentor_id THEN PERFORM internal.agenda_reject('agenda_immutable'); END IF;
  IF NEW.topic_id IS DISTINCT FROM OLD.topic_id AND EXISTS (SELECT 1 FROM public.cohort c WHERE c.mentor_topic_id = OLD.id) THEN
   PERFORM internal.agenda_reject('agenda_cohort_in_use');
  END IF;
 ELSIF TG_TABLE_NAME = 'enrollment' AND TG_OP = 'UPDATE' THEN
  IF NEW.participant_id IS DISTINCT FROM OLD.participant_id OR NEW.cohort_id IS DISTINCT FROM OLD.cohort_id THEN PERFORM internal.agenda_reject('agenda_immutable'); END IF;
 ELSIF TG_TABLE_NAME = 'cohort' THEN
  IF TG_OP = 'INSERT' THEN
   IF NEW.status NOT IN ('draft','open') THEN PERFORM internal.agenda_reject('agenda_invalid_transition'); END IF;
   IF NEW.starts_at <= now() THEN PERFORM internal.agenda_reject('agenda_not_future'); END IF;
  ELSE
   IF OLD.status = 'cancelled' AND (NEW.status, NEW.mentor_topic_id, NEW.starts_at, NEW.ends_at, NEW.capacity) IS DISTINCT FROM (OLD.status, OLD.mentor_topic_id, OLD.starts_at, OLD.ends_at, OLD.capacity) THEN
    PERFORM internal.agenda_reject('agenda_invalid_transition');
   END IF;
   IF NEW.status <> OLD.status AND NOT ((OLD.status = 'draft' AND NEW.status IN ('open','cancelled')) OR (OLD.status = 'open' AND NEW.status IN ('closed','cancelled')) OR (OLD.status = 'closed' AND NEW.status IN ('open','cancelled'))) THEN
    PERFORM internal.agenda_reject('agenda_invalid_transition');
   END IF;
   IF NEW.status = 'open' AND OLD.status <> 'open' AND NEW.starts_at <= now() THEN PERFORM internal.agenda_reject('agenda_not_future'); END IF;
   IF (NEW.mentor_topic_id, NEW.starts_at, NEW.ends_at) IS DISTINCT FROM (OLD.mentor_topic_id, OLD.starts_at, OLD.ends_at) THEN
    IF EXISTS (SELECT 1 FROM public.enrollment e WHERE e.cohort_id = OLD.id AND e.status = 'active') THEN PERFORM internal.agenda_reject('agenda_cohort_in_use'); END IF;
    IF NEW.starts_at <= now() THEN PERFORM internal.agenda_reject('agenda_not_future'); END IF;
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.agenda_reject(text), internal.agenda_row_check() FROM PUBLIC;
--> statement-breakpoint
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['topic','mentor_topic','cohort','enrollment','mentor','participant'] LOOP
  EXECUTE format('CREATE TRIGGER agenda_row BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION internal.agenda_row_check()', t);
 END LOOP;
END $$;
--> statement-breakpoint
-- Owner das funções de Agenda: NOLOGIN, sem BYPASSRLS/superuser. Criado aqui só se a migradora puder (local/teste);
-- em produção o operador aplica antes scripts/migration/agenda-privileges.sql. Atributos inseguros abortam (fail-closed).
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_owner') THEN
  IF NOT (SELECT rolsuper OR rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
   RAISE EXCEPTION 'techwoman_owner ausente: aplicar scripts/migration/agenda-privileges.sql como operador antes desta migration';
  END IF;
  CREATE ROLE techwoman_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_owner' AND (rolcanlogin OR rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
  RAISE EXCEPTION 'techwoman_owner deve ser NOLOGIN sem BYPASSRLS/privilégios de cluster';
 END IF;
END $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, internal TO techwoman_owner;
GRANT SELECT, UPDATE ON internal.agenda_guard TO techwoman_owner;
GRANT SELECT ON public.topic, public.mentor_topic, public.cohort, public.enrollment, public.mentor, public.participant TO techwoman_owner;
--> statement-breakpoint
-- ALTER OWNER exige CREATE do novo dono no schema: concedido só durante a transferência.
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.acquire_agenda_guard() OWNER TO techwoman_owner;
ALTER FUNCTION internal.validate_agenda_state() OWNER TO techwoman_owner;
ALTER FUNCTION internal.agenda_row_check() OWNER TO techwoman_owner;
ALTER FUNCTION internal.agenda_reject(text) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
