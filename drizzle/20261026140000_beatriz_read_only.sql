-- D-048 (CAND-DEPS-RO): techwoman_beatriz (editora/pgAdmin) passa a SOMENTE LEITURA no repo, como já está no host. Migration nova;
-- a WP-003 (20261023090000_wp003_agenda.sql) não é editada. Fica: SELECT (agenda e views inteiras, perfil de participante/mentora
-- só por coluna), USAGE de public/internal e EXECUTE de internal.agenda_editor_visible (usado pelas policies). Sai: INSERT/UPDATE/
-- DELETE/TRUNCATE/REFERENCES/TRIGGER em tabelas e views, inclusive os grants por coluna, e todo privilégio nas sequences.
-- Idempotente e nunca amplia grants: REVOKE de privilégio ausente é no-op (host já revogado à mão) e as policies são recriadas.
-- Um REVOKE de tabela não remove grant por coluna feito por OUTRO grantor; por isso o fim confere o catálogo inteiro (qualquer
-- grantor, efetivo via PUBLIC também) e aborta a transação se sobrar escrita: o operador remove o grant estranho e reaplica.
-- default_transaction_read_only=on é setting de role (ALTER ROLE exige CREATEROLE, que a migradora não tem): fica nos provisionadores
-- do operador (scripts/migration/agenda-privileges.sql e ops/sql/role-limits.sql) e é conferido pelo PF-ROLE-LIMITS.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.topic, public.mentor_topic, public.cohort, public.enrollment,
 public.participant, public.mentor, public.participant_editor, public.mentor_editor FROM techwoman_beatriz;
REVOKE INSERT (slug, name, description, active), UPDATE (name, description, active) ON public.topic FROM techwoman_beatriz;
REVOKE INSERT (mentor_id, topic_id, position), UPDATE (position) ON public.mentor_topic FROM techwoman_beatriz;
REVOKE INSERT (mentor_topic_id, starts_at, ends_at, capacity, status), UPDATE (starts_at, ends_at, capacity, status) ON public.cohort FROM techwoman_beatriz;
REVOKE INSERT (participant_id, cohort_id, status), UPDATE (status) ON public.enrollment FROM techwoman_beatriz;
REVOKE UPDATE (goal, moment, interests, skills, area, active) ON public.participant, public.participant_editor FROM techwoman_beatriz;
REVOKE UPDATE (display_name, trajectory, specialties, availability, capacity, active) ON public.mentor, public.mentor_editor FROM techwoman_beatriz;
REVOKE ALL ON SEQUENCE public.topic_id_seq, public.mentor_topic_id_seq, public.cohort_id_seq, public.enrollment_id_seq FROM techwoman_beatriz;
--> statement-breakpoint
-- Qualquer outra entrada de escrita da editora (tabela, view, coluna ou sequence de public/internal/legacy_snapshot) também sai.
DO $$ DECLARE r record; BEGIN
 FOR r IN SELECT c.oid::regclass AS rel, c.relkind FROM pg_catalog.pg_class c
   WHERE c.relnamespace IN ('public'::regnamespace, 'internal'::regnamespace, 'legacy_snapshot'::regnamespace)
     AND EXISTS (SELECT 1 FROM aclexplode(c.relacl) a WHERE a.grantee = 'techwoman_beatriz'::regrole AND (c.relkind = 'S' OR a.privilege_type <> 'SELECT'))
   ORDER BY c.oid LOOP
  IF r.relkind = 'S' THEN EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM techwoman_beatriz', r.rel);
  ELSE EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON TABLE %s FROM techwoman_beatriz', r.rel);
  END IF;
 END LOOP;
 FOR r IN SELECT DISTINCT c.oid::regclass AS rel, t.attname, a.privilege_type FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute t ON t.attrelid = c.oid,
   aclexplode(t.attacl) a
   WHERE c.relnamespace IN ('public'::regnamespace, 'internal'::regnamespace, 'legacy_snapshot'::regnamespace)
     AND a.grantee = 'techwoman_beatriz'::regrole AND a.privilege_type <> 'SELECT' ORDER BY 1, 2, 3 LOOP
  EXECUTE format('REVOKE %s (%I) ON TABLE %s FROM techwoman_beatriz', r.privilege_type, r.attname, r.rel);
 END LOOP;
END $$;
--> statement-breakpoint
-- Policies da editora: só leitura, mesmo USING da WP-003 (R3 via internal.agenda_editor_visible); sem WITH CHECK.
DROP POLICY IF EXISTS agenda_editor ON public.topic;
CREATE POLICY agenda_editor ON public.topic FOR SELECT TO techwoman_beatriz USING (true);
DROP POLICY IF EXISTS agenda_editor ON public.participant;
CREATE POLICY agenda_editor ON public.participant FOR SELECT TO techwoman_beatriz USING (internal.agenda_editor_visible('participant', id));
DROP POLICY IF EXISTS agenda_editor ON public.mentor;
CREATE POLICY agenda_editor ON public.mentor FOR SELECT TO techwoman_beatriz USING (internal.agenda_editor_visible('mentor', id));
DROP POLICY IF EXISTS agenda_editor ON public.mentor_topic;
CREATE POLICY agenda_editor ON public.mentor_topic FOR SELECT TO techwoman_beatriz USING (internal.agenda_editor_visible('mentor', mentor_id));
DROP POLICY IF EXISTS agenda_editor ON public.cohort;
CREATE POLICY agenda_editor ON public.cohort FOR SELECT TO techwoman_beatriz USING (internal.agenda_editor_visible('mentor_topic', mentor_topic_id));
DROP POLICY IF EXISTS agenda_editor ON public.enrollment;
CREATE POLICY agenda_editor ON public.enrollment FOR SELECT TO techwoman_beatriz
 USING (internal.agenda_editor_visible('participant', participant_id) AND internal.agenda_editor_visible('cohort', cohort_id));
--> statement-breakpoint
-- Fail-closed: nenhuma escrita da editora pode sobrar (ACL de qualquer grantor, efetivo via PUBLIC, default ACL).
DO $$ DECLARE v_left text; BEGIN
 SELECT string_agg(x, ', ' ORDER BY x) INTO v_left FROM (
  SELECT c.oid::regclass::text || ' ' || a.privilege_type || ' por ' || pg_catalog.pg_get_userbyid(a.grantor) AS x FROM pg_catalog.pg_class c, aclexplode(c.relacl) a
   WHERE c.relnamespace IN ('public'::regnamespace, 'internal'::regnamespace, 'legacy_snapshot'::regnamespace)
     AND a.grantee = 'techwoman_beatriz'::regrole AND (c.relkind = 'S' OR a.privilege_type <> 'SELECT')
  UNION ALL
  SELECT c.oid::regclass::text || '.' || t.attname || ' ' || a.privilege_type || ' por ' || pg_catalog.pg_get_userbyid(a.grantor)
   FROM pg_catalog.pg_class c JOIN pg_catalog.pg_attribute t ON t.attrelid = c.oid, aclexplode(t.attacl) a
   WHERE c.relnamespace IN ('public'::regnamespace, 'internal'::regnamespace, 'legacy_snapshot'::regnamespace)
     AND a.grantee = 'techwoman_beatriz'::regrole AND a.privilege_type <> 'SELECT'
  UNION ALL
  SELECT c.oid::regclass::text || ' escrita efetiva' FROM pg_catalog.pg_class c
   WHERE c.relnamespace IN ('public'::regnamespace, 'internal'::regnamespace, 'legacy_snapshot'::regnamespace)
     AND ((c.relkind IN ('r', 'v', 'p', 'm', 'f') AND (has_table_privilege('techwoman_beatriz', c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
            OR has_any_column_privilege('techwoman_beatriz', c.oid, 'INSERT, UPDATE, REFERENCES')))
       OR (c.relkind = 'S' AND has_sequence_privilege('techwoman_beatriz', c.oid, 'USAGE, UPDATE, SELECT')))
  UNION ALL
  SELECT 'default ACL ' || d.defaclobjtype::text || ' ' || a.privilege_type FROM pg_catalog.pg_default_acl d, aclexplode(d.defaclacl) a
   WHERE a.grantee = 'techwoman_beatriz'::regrole
 ) w;
 IF v_left IS NOT NULL THEN
  RAISE EXCEPTION 'techwoman_beatriz ainda tem escrita (grant de outro grantor ou PUBLIC; remover e reaplicar): %', v_left;
 END IF;
END $$;
