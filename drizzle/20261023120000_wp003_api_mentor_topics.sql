-- WP-003 Task 3: temas da mentora (mentor_topic). Escrita: admin (mentora não protegida) ou a própria mentora (user_id da sessão); leitura também team.
-- Outra mentora/participante → 404 idêntico ao inexistente; team em escrita → 403. Mentora protegida (admin/candidato) fica fora do CRUD comum.

-- Mentora dona de uma linha de agenda (mentor, mentor_topic ou cohort); NULL se não existe.
CREATE OR REPLACE FUNCTION internal.api_mentor_of(p_kind text, p_id bigint) RETURNS bigint
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE p_kind
  WHEN 'mentor' THEN (SELECT m.id FROM public.mentor m WHERE m.id = p_id)
  WHEN 'mentor_topic' THEN (SELECT mt.mentor_id FROM public.mentor_topic mt WHERE mt.id = p_id)
  WHEN 'cohort' THEN (SELECT mt.mentor_id FROM public.cohort c JOIN public.mentor_topic mt ON mt.id = c.mentor_topic_id WHERE c.id = p_id)
 END;
$$;
--> statement-breakpoint
-- Autorização sobre a agenda de uma mentora, avaliada DEPOIS dos locks (o lock da conta serializa com a elevação offline).
CREATE OR REPLACE FUNCTION internal.api_mentor_scope(p_actor uuid, p_roles text[], p_mentor bigint, p_write boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_owner uuid;
BEGIN
 SELECT m.user_id INTO v_owner FROM public.mentor m WHERE m.id = p_mentor;
 IF NOT FOUND THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 IF 'mentor' = ANY (p_roles) AND v_owner = p_actor THEN RETURN; END IF;
 IF NOT (p_roles && ARRAY['admin','team']) OR internal.domain_protected('mentor', p_mentor) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 IF p_write AND NOT ('admin' = ANY (p_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
END $$;
--> statement-breakpoint
-- Escrita na agenda de uma mentora: trava ator + dona (UUID) → guard → confirma que a dona não mudou durante a espera (senão 40001 e retry integral).
CREATE OR REPLACE FUNCTION internal.api_mentor_write(p_digest text, p_request uuid, p_kind text, p_id bigint, OUT o_actor uuid, OUT o_roles text[], OUT o_mentor bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; v_owner uuid;
BEGIN
 o_mentor := internal.api_mentor_of(p_kind, p_id);
 SELECT m.user_id INTO v_owner FROM public.mentor m WHERE m.id = o_mentor;
 SELECT * INTO a FROM internal.api_auth(p_digest, CASE WHEN v_owner IS NULL THEN ARRAY[]::uuid[] ELSE ARRAY[v_owner] END, p_request);
 o_actor := a.o_actor; o_roles := a.o_roles;
 PERFORM internal.api_guard();
 IF internal.api_mentor_of(p_kind, p_id) IS DISTINCT FROM o_mentor OR (SELECT m.user_id FROM public.mentor m WHERE m.id = o_mentor) IS DISTINCT FROM v_owner THEN
  RAISE EXCEPTION 'agenda owner changed' USING ERRCODE = '40001';
 END IF;
 IF o_mentor IS NULL THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 PERFORM internal.api_mentor_scope(o_actor, o_roles, o_mentor, true);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_mentor_read(p_digest text, p_kind text, p_id bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; v_mentor bigint;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 v_mentor := internal.api_mentor_of(p_kind, p_id);
 IF v_mentor IS NULL THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 PERFORM internal.api_mentor_scope(a.o_actor, a.o_roles, v_mentor, false);
 RETURN v_mentor;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_mentor_topic_json(mt public.mentor_topic) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT jsonb_build_object('id', mt.id::text, 'mentorId', mt.mentor_id::text, 'topicId', mt.topic_id::text, 'position', mt.position, 'version', mt.version::text);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_mentor_topics_of(p_mentor bigint) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT coalesce(jsonb_agg(internal.api_mentor_topic_json(mt) ORDER BY mt.position, mt.id), '[]'::jsonb) FROM public.mentor_topic mt WHERE mt.mentor_id = p_mentor;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_mentor_topic_list(p_digest text, p_mentor bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN RETURN internal.api_mentor_topics_of(internal.api_mentor_read(p_digest, 'mentor', p_mentor)); END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_mentor_topic_get(p_digest text, p_id bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE mt public.mentor_topic%ROWTYPE;
BEGIN
 PERFORM internal.api_mentor_read(p_digest, 'mentor_topic', p_id);
 SELECT * INTO mt FROM public.mentor_topic x WHERE x.id = p_id;
 RETURN internal.api_mentor_topic_json(mt);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_sql_id(p_value jsonb, p_field text) RETURNS bigint
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value) <> 'string' OR (p_value #>> '{}') !~ '^[1-9][0-9]{0,18}$' OR (p_value #>> '{}')::numeric > 9223372036854775807 THEN
  PERFORM internal.api_fail('INVALID_INPUT', ARRAY[p_field]);
 END IF;
 RETURN (p_value #>> '{}')::bigint;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_int(p_value jsonb, p_field text, p_min integer, p_max integer) RETURNS integer
LANGUAGE plpgsql SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_value IS NULL OR jsonb_typeof(p_value) <> 'number' OR (p_value #>> '{}') !~ '^-?[0-9]{1,6}$' OR (p_value #>> '{}')::integer NOT BETWEEN p_min AND p_max THEN
  PERFORM internal.api_fail('INVALID_INPUT', ARRAY[p_field]);
 END IF;
 RETURN (p_value #>> '{}')::integer;
END $$;
--> statement-breakpoint
-- POST {topicId,position}: tema ativo; terceiro vínculo, tema repetido ou posição ocupada → TOPIC_LIMIT (o validador integral também fecha).
CREATE OR REPLACE FUNCTION internal.api_mentor_topic_create(p_digest text, p_request uuid, p_key uuid, p_hash text, p_mentor bigint, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w record; i record; mt public.mentor_topic%ROWTYPE; v_topic bigint; v_position integer;
BEGIN
 SELECT * INTO w FROM internal.api_mentor_write(p_digest, p_request, 'mentor', p_mentor);
 SELECT * INTO i FROM internal.api_idem(w.o_actor, '/api/v1/mentors/' || p_mentor::text || '/topics', p_key, p_hash);
 IF NOT i.o_new THEN
  SELECT * INTO mt FROM public.mentor_topic x WHERE x.id = i.o_resource::bigint AND x.mentor_id = p_mentor;
  IF NOT FOUND THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
  RETURN internal.api_mentor_topic_json(mt);
 END IF;
 PERFORM internal.api_patch_keys(p_body, ARRAY['topicId','position']);
 v_topic := internal.api_sql_id(p_body -> 'topicId', 'topicId');
 v_position := internal.api_int(p_body -> 'position', 'position', 1, 2);
 IF NOT EXISTS (SELECT 1 FROM public.topic t WHERE t.id = v_topic AND t.active) THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['topicId']); END IF;
 PERFORM 1 FROM public.mentor_topic x WHERE x.mentor_id = p_mentor ORDER BY x.id FOR NO KEY UPDATE;
 IF (SELECT count(*) FROM public.mentor_topic x WHERE x.mentor_id = p_mentor) >= 2
  OR EXISTS (SELECT 1 FROM public.mentor_topic x WHERE x.mentor_id = p_mentor AND (x.topic_id = v_topic OR x.position = v_position)) THEN
  PERFORM internal.api_fail('TOPIC_LIMIT');
 END IF;
 INSERT INTO public.mentor_topic(mentor_id, topic_id, position) VALUES (p_mentor, v_topic, v_position) RETURNING * INTO mt;
 PERFORM internal.api_audit(w.o_actor, 'mentor_topic.create', 'mentor_topic', mt.id::text, '["topicId","position"]'::jsonb, p_request);
 PERFORM internal.idem_finish(i.o_id, mt.id::text, 201);
 RETURN internal.api_mentor_topic_json(mt);
END $$;
--> statement-breakpoint
-- Troca atômica: os dois vínculos da mentora, UNIQUE (mentor_id,position) adiado só nesta transação; posições finais 1/2, sem terceiro vínculo.
CREATE OR REPLACE FUNCTION internal.api_mentor_topic_reorder(p_digest text, p_request uuid, p_mentor bigint, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w record; v_first bigint; v_second bigint; v_links bigint[];
BEGIN
 SELECT * INTO w FROM internal.api_mentor_write(p_digest, p_request, 'mentor', p_mentor);
 PERFORM internal.api_patch_keys(p_body, ARRAY['firstId','secondId']);
 v_first := internal.api_sql_id(p_body -> 'firstId', 'firstId');
 v_second := internal.api_sql_id(p_body -> 'secondId', 'secondId');
 v_links := ARRAY(SELECT x.id FROM public.mentor_topic x WHERE x.mentor_id = p_mentor ORDER BY x.id FOR NO KEY UPDATE);
 IF v_first = v_second OR cardinality(v_links) <> 2 OR NOT (v_links @> ARRAY[v_first, v_second]) THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['firstId','secondId']); END IF;
 SET CONSTRAINTS public.mentor_topic_position_unique DEFERRED;
 UPDATE public.mentor_topic x SET position = CASE WHEN x.id = v_first THEN 1 ELSE 2 END
  WHERE x.id IN (v_first, v_second) AND x.position IS DISTINCT FROM CASE WHEN x.id = v_first THEN 1 ELSE 2 END;
 SET CONSTRAINTS public.mentor_topic_position_unique IMMEDIATE;
 PERFORM internal.api_audit(w.o_actor, 'mentor_topic.reorder', 'mentor_topic', v_first::text || ',' || v_second::text, '["position"]'::jsonb, p_request);
 RETURN internal.api_mentor_topics_of(p_mentor);
END $$;
--> statement-breakpoint
-- PATCH {position} (posição livre; troca entre as duas só via reorder) e DELETE (sem turma referenciando; FK recusa).
CREATE OR REPLACE FUNCTION internal.api_mentor_topic_update(p_digest text, p_request uuid, p_id bigint, p_version bigint, p_patch jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w record; mt public.mentor_topic%ROWTYPE; v_position integer;
BEGIN
 SELECT * INTO w FROM internal.api_mentor_write(p_digest, p_request, 'mentor_topic', p_id);
 PERFORM internal.api_patch_keys(p_patch, ARRAY['position']);
 v_position := internal.api_int(p_patch -> 'position', 'position', 1, 2);
 SELECT * INTO mt FROM public.mentor_topic x WHERE x.id = p_id FOR NO KEY UPDATE;
 IF mt.version IS DISTINCT FROM p_version THEN PERFORM internal.api_fail('VERSION_MISMATCH'); END IF;
 IF mt.position = v_position THEN RETURN internal.api_mentor_topic_json(mt); END IF;
 IF EXISTS (SELECT 1 FROM public.mentor_topic x WHERE x.mentor_id = mt.mentor_id AND x.position = v_position) THEN PERFORM internal.api_fail('TOPIC_LIMIT'); END IF;
 UPDATE public.mentor_topic x SET position = v_position WHERE x.id = p_id RETURNING * INTO mt;
 PERFORM internal.api_audit(w.o_actor, 'mentor_topic.update', 'mentor_topic', mt.id::text, '["position"]'::jsonb, p_request);
 RETURN internal.api_mentor_topic_json(mt);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_mentor_topic_delete(p_digest text, p_request uuid, p_id bigint, p_version bigint) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE w record; mt public.mentor_topic%ROWTYPE;
BEGIN
 SELECT * INTO w FROM internal.api_mentor_write(p_digest, p_request, 'mentor_topic', p_id);
 SELECT * INTO mt FROM public.mentor_topic x WHERE x.id = p_id FOR NO KEY UPDATE;
 IF mt.version IS DISTINCT FROM p_version THEN PERFORM internal.api_fail('VERSION_MISMATCH'); END IF;
 IF EXISTS (SELECT 1 FROM public.cohort c WHERE c.mentor_topic_id = p_id) THEN PERFORM internal.api_fail('COHORT_IN_USE'); END IF;
 DELETE FROM public.mentor_topic x WHERE x.id = p_id;
 PERFORM internal.api_audit(w.o_actor, 'mentor_topic.delete', 'mentor_topic', p_id::text, '[]'::jsonb, p_request);
 RETURN jsonb_build_object('id', p_id::text);
END $$;
--> statement-breakpoint
GRANT INSERT (mentor_id, topic_id, position), UPDATE (position), DELETE ON public.mentor_topic TO techwoman_owner;
GRANT USAGE ON SEQUENCE public.mentor_topic_id_seq TO techwoman_owner;
GRANT EXECUTE ON FUNCTION internal.domain_protected(text,bigint) TO techwoman_owner;
CREATE POLICY agenda_api_owner_delete ON public.mentor_topic FOR DELETE TO techwoman_owner USING (true);
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.api_mentor_of(text,bigint), internal.api_mentor_scope(uuid,text[],bigint,boolean), internal.api_mentor_write(text,uuid,text,bigint),
 internal.api_mentor_read(text,text,bigint), internal.api_mentor_topic_json(public.mentor_topic), internal.api_mentor_topics_of(bigint), internal.api_mentor_topic_list(text,bigint),
 internal.api_mentor_topic_get(text,bigint), internal.api_sql_id(jsonb,text), internal.api_int(jsonb,text,integer,integer), internal.api_mentor_topic_create(text,uuid,uuid,text,bigint,jsonb),
 internal.api_mentor_topic_reorder(text,uuid,bigint,jsonb), internal.api_mentor_topic_update(text,uuid,bigint,bigint,jsonb), internal.api_mentor_topic_delete(text,uuid,bigint,bigint) FROM PUBLIC;
--> statement-breakpoint
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_of(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_scope(uuid,text[],bigint,boolean) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_write(text,uuid,text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_read(text,text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_topic_json(public.mentor_topic) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_topics_of(bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_topic_list(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_topic_get(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_sql_id(jsonb,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_int(jsonb,text,integer,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_topic_create(text,uuid,uuid,text,bigint,jsonb) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_topic_reorder(text,uuid,bigint,jsonb) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_topic_update(text,uuid,bigint,bigint,jsonb) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_mentor_topic_delete(text,uuid,bigint,bigint) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.api_mentor_topic_list(text,bigint), internal.api_mentor_topic_get(text,bigint), internal.api_mentor_topic_create(text,uuid,uuid,text,bigint,jsonb),
   internal.api_mentor_topic_reorder(text,uuid,bigint,jsonb), internal.api_mentor_topic_update(text,uuid,bigint,bigint,jsonb), internal.api_mentor_topic_delete(text,uuid,bigint,bigint) TO techwoman_runtime;
 END IF;
END $$;
