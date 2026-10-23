-- WP-003 Task 1: guard global de Agenda, transições/imutabilidade e validação integral por statement.
-- Ordem de locks: app_user (API, em ordem de UUID) -> internal.agenda_guard -> domínio. SQL direto da editora começa pelo guard.
-- Escrita real da revisão (não só FOR UPDATE): snapshot REPEATABLE READ/SERIALIZABLE obsoleto falha com 40001.
-- lock_timeout próprio: nenhuma sessão (pgAdmin, runtime) espera o guard indefinidamente; 55P03 vira conflito/retry no serviço.
CREATE OR REPLACE FUNCTION internal.acquire_agenda_guard() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, pg_temp SET lock_timeout = '5s' AS $$
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
--> statement-breakpoint
-- Editora (Beatriz/pgAdmin): role de domínio, nunca dona de objeto. Criada NOLOGIN se ausente e permitido; LOGIN/senha só pelo operador.
DO $$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_beatriz') THEN
  IF NOT (SELECT rolsuper OR rolcreaterole FROM pg_catalog.pg_roles WHERE rolname = current_user) THEN
   RAISE EXCEPTION 'techwoman_beatriz ausente: aplicar scripts/migration/agenda-privileges.sql como operador antes desta migration';
  END IF;
  CREATE ROLE techwoman_beatriz NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_beatriz' AND (rolbypassrls OR rolsuper OR rolcreaterole OR rolcreatedb OR rolreplication)) THEN
  RAISE EXCEPTION 'techwoman_beatriz não pode ter BYPASSRLS/privilégios de cluster';
 END IF;
END $$;
--> statement-breakpoint
-- Views seguras: só campos de perfil permitidos, avaliadas com privilégios/RLS de quem consulta.
CREATE VIEW public.participant_editor WITH (security_invoker = true, security_barrier = true) AS
 SELECT id, goal, moment, interests, skills, area, active, version, created_at, updated_at FROM public.participant;
CREATE VIEW public.mentor_editor WITH (security_invoker = true, security_barrier = true) AS
 SELECT id, display_name, trajectory, specialties, availability, capacity, active, demo, version, created_at, updated_at FROM public.mentor;
--> statement-breakpoint
-- Grants por coluna da editora: sem DELETE destrutivo (só mentor_topic vazio), sem TRUNCATE/REFERENCES/TRIGGER, sem id/FK de identidade.
GRANT USAGE ON SCHEMA public TO techwoman_beatriz;
GRANT SELECT, INSERT (slug, name, description, active), UPDATE (name, description, active) ON public.topic TO techwoman_beatriz;
GRANT SELECT, INSERT (mentor_id, topic_id, position), UPDATE (position), DELETE ON public.mentor_topic TO techwoman_beatriz;
GRANT SELECT, INSERT (mentor_topic_id, starts_at, ends_at, capacity, status), UPDATE (starts_at, ends_at, capacity, status) ON public.cohort TO techwoman_beatriz;
GRANT SELECT, INSERT (participant_id, cohort_id, status), UPDATE (status) ON public.enrollment TO techwoman_beatriz;
GRANT SELECT (id, goal, moment, interests, skills, area, active, version, created_at, updated_at), UPDATE (goal, moment, interests, skills, area, active) ON public.participant TO techwoman_beatriz;
GRANT SELECT (id, display_name, trajectory, specialties, availability, capacity, active, demo, version, created_at, updated_at), UPDATE (display_name, trajectory, specialties, availability, capacity, active) ON public.mentor TO techwoman_beatriz;
GRANT SELECT, UPDATE (goal, moment, interests, skills, area, active) ON public.participant_editor TO techwoman_beatriz;
GRANT SELECT, UPDATE (display_name, trajectory, specialties, availability, capacity, active) ON public.mentor_editor TO techwoman_beatriz;
GRANT USAGE ON SEQUENCE public.topic_id_seq, public.mentor_topic_id_seq, public.cohort_id_seq, public.enrollment_id_seq TO techwoman_beatriz;
--> statement-breakpoint
-- R3: visibilidade da editora reutiliza o predicado entregue internal.domain_protected (admin/team vinculado, e-mail de admin/team,
-- candidato privilegiado/colisão/pendência privilegiada, inclusive com user_id NULL), sem inferir posse nem conceder papel.
-- Retorna só boolean; executa como owner para enxergar vínculos ocultos.
GRANT EXECUTE ON FUNCTION internal.domain_protected(text, bigint) TO techwoman_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.agenda_editor_visible(p_kind text, p_id bigint) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_mentor bigint;
BEGIN
 IF p_kind = 'participant' THEN RETURN NOT internal.domain_protected('participant', p_id);
 ELSIF p_kind = 'mentor' THEN v_mentor := p_id;
 ELSIF p_kind = 'mentor_topic' THEN SELECT mt.mentor_id INTO v_mentor FROM public.mentor_topic mt WHERE mt.id = p_id;
 ELSIF p_kind = 'cohort' THEN SELECT mt.mentor_id INTO v_mentor FROM public.cohort c JOIN public.mentor_topic mt ON mt.id = c.mentor_topic_id WHERE c.id = p_id;
 ELSE RETURN false; END IF;
 RETURN v_mentor IS NULL OR NOT internal.domain_protected('mentor', v_mentor);
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.agenda_editor_visible(text, bigint) FROM PUBLIC;
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.agenda_editor_visible(text, bigint) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
GRANT USAGE ON SCHEMA internal TO techwoman_beatriz;
GRANT EXECUTE ON FUNCTION internal.agenda_editor_visible(text, bigint) TO techwoman_beatriz;
--> statement-breakpoint
-- FORCE RLS nas seis tabelas, políticas explícitas (ninguém tem BYPASSRLS):
-- dono da tabela (migradora; funções WP-002) e runtime leem tudo (o backend aplica a exclusão antes de listar/alterar);
-- owner das funções de Agenda lê o conjunto integral para validar; editora só o domínio não protegido.
DO $$ DECLARE t text; v_table_owner text; BEGIN
 FOREACH t IN ARRAY ARRAY['topic','mentor_topic','cohort','enrollment','mentor','participant'] LOOP
  SELECT pg_catalog.pg_get_userbyid(c.relowner) INTO v_table_owner FROM pg_catalog.pg_class c WHERE c.oid = ('public.' || t)::regclass;
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY', t);
  EXECUTE format('CREATE POLICY agenda_table_owner ON public.%I FOR ALL TO %I USING (true) WITH CHECK (true)', t, v_table_owner);
  EXECUTE format('CREATE POLICY agenda_function_owner ON public.%I FOR SELECT TO techwoman_owner USING (true)', t);
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_runtime') THEN
   EXECUTE format('CREATE POLICY agenda_runtime ON public.%I FOR ALL TO techwoman_runtime USING (true) WITH CHECK (true)', t);
  END IF;
 END LOOP;
END $$;
--> statement-breakpoint
CREATE POLICY agenda_editor ON public.topic FOR ALL TO techwoman_beatriz USING (true) WITH CHECK (true);
CREATE POLICY agenda_editor ON public.participant FOR ALL TO techwoman_beatriz
 USING (internal.agenda_editor_visible('participant', id)) WITH CHECK (internal.agenda_editor_visible('participant', id));
CREATE POLICY agenda_editor ON public.mentor FOR ALL TO techwoman_beatriz
 USING (internal.agenda_editor_visible('mentor', id)) WITH CHECK (internal.agenda_editor_visible('mentor', id));
CREATE POLICY agenda_editor ON public.mentor_topic FOR ALL TO techwoman_beatriz
 USING (internal.agenda_editor_visible('mentor', mentor_id)) WITH CHECK (internal.agenda_editor_visible('mentor', mentor_id));
CREATE POLICY agenda_editor ON public.cohort FOR ALL TO techwoman_beatriz
 USING (internal.agenda_editor_visible('mentor_topic', mentor_topic_id)) WITH CHECK (internal.agenda_editor_visible('mentor_topic', mentor_topic_id));
CREATE POLICY agenda_editor ON public.enrollment FOR ALL TO techwoman_beatriz
 USING (internal.agenda_editor_visible('participant', participant_id) AND internal.agenda_editor_visible('cohort', cohort_id))
 WITH CHECK (internal.agenda_editor_visible('participant', participant_id) AND internal.agenda_editor_visible('cohort', cohort_id));
