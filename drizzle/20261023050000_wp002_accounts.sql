-- WP-002 Task 3 (A): predicado de proteção reutilizável, CRUD administrativo de contas e idempotência.
-- Ordem de locks (igual ao CRUD e à elevação offline): app_user (ator e alvo, em ordem de UUID) -> agenda_guard -> domínio/jobs.
-- Chaves de e-mail sinalizadas pelo mapa privado da migração: o runtime nunca lê as tabelas de migração, só os booleanos abaixo.
CREATE OR REPLACE FUNCTION internal.migration_flagged_keys(p_collision_only boolean) RETURNS TABLE(ekey text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 WITH refs(t, k, u) AS (
  SELECT l.source_table, l.source_key, l.user_id FROM public.migration_identity_link l
   WHERE l.resolution = ANY (CASE WHEN p_collision_only THEN ARRAY['credential_conflict'] ELSE ARRAY['privileged_candidate','credential_conflict'] END)
  UNION
  SELECT i.source_table, i.source_key, NULL::uuid FROM public.migration_issue i
   WHERE i.resolved_at IS NULL AND i.code = ANY (CASE WHEN p_collision_only THEN ARRAY['CREDENTIAL_COLLISION'] ELSE ARRAY['CREDENTIAL_COLLISION','PRIVILEGED_DOMAIN_UNRESOLVED','UNSUPPORTED_CREDENTIAL'] END)
 )
 SELECT lower(btrim(r.k)) FROM refs r WHERE r.t = 'admin_user'
 UNION SELECT lower(btrim(p.email)) FROM refs r JOIN public.participant p ON r.t = 'participant' AND p.id = CASE WHEN r.k ~ '^[0-9]{1,18}$' THEN r.k::bigint END
 UNION SELECT lower(btrim(m.email)) FROM refs r JOIN public.mentor m ON r.t = 'mentor' AND m.id = CASE WHEN r.k ~ '^[0-9]{1,18}$' THEN r.k::bigint END
 UNION SELECT a.email_key FROM refs r JOIN public.app_user a ON a.id = r.u;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.privileged_email_keys() RETURNS TABLE(ekey text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT k.ekey FROM internal.migration_flagged_keys(false) k; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.collision_unresolved(p_key text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT p_key IN (SELECT k.ekey FROM internal.migration_flagged_keys(true) k); $$;
--> statement-breakpoint
-- Conta protegida: admin/team (conservador), ou e-mail ligado a candidato privilegiado/colisão de credencial/pendência não resolvida. Inexistente → false (o chamador trata 404).
CREATE OR REPLACE FUNCTION internal.user_protected(p_user uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM public.user_role r WHERE r.user_id = p_user AND r.role IN ('admin','team'))
     OR EXISTS (SELECT 1 FROM public.app_user u WHERE u.id = p_user AND u.email_key IN (SELECT k.ekey FROM internal.privileged_email_keys() k));
$$;
--> statement-breakpoint
-- Linha de domínio protegida: dono protegido; sem dono mas com e-mail de admin/team; chave privilegiada; vínculo/pendência privilegiada da própria linha. ambiguous_domain NÃO é privilegiado.
CREATE OR REPLACE FUNCTION internal.domain_protected(p_table text, p_id bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; v_key text;
BEGIN
 IF p_table = 'participant' THEN SELECT d.user_id, lower(btrim(d.email)) INTO v_user, v_key FROM public.participant d WHERE d.id = p_id;
 ELSIF p_table = 'mentor' THEN SELECT d.user_id, lower(btrim(d.email)) INTO v_user, v_key FROM public.mentor d WHERE d.id = p_id;
 ELSE RETURN true; END IF;
 IF NOT FOUND THEN RETURN false; END IF;
 RETURN (v_user IS NOT NULL AND internal.user_protected(v_user))
  OR EXISTS (SELECT 1 FROM public.user_role r JOIN public.app_user a ON a.id = r.user_id WHERE r.role IN ('admin','team') AND a.email_key = v_key)
  OR v_key IN (SELECT k.ekey FROM internal.privileged_email_keys() k)
  OR EXISTS (SELECT 1 FROM public.migration_identity_link l WHERE l.source_table = p_table AND l.source_key = p_id::text AND l.resolution IN ('privileged_candidate','credential_conflict'))
  OR EXISTS (SELECT 1 FROM public.migration_issue i WHERE i.resolved_at IS NULL AND i.source_table = p_table AND i.source_key = p_id::text AND i.code IN ('CREDENTIAL_COLLISION','PRIVILEGED_DOMAIN_UNRESOLVED','UNSUPPORTED_CREDENTIAL'));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.lock_users(p_a uuid, p_b uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_b IS NULL OR p_a = p_b THEN PERFORM 1 FROM public.app_user WHERE id = p_a FOR UPDATE;
 ELSIF p_a < p_b THEN PERFORM 1 FROM public.app_user WHERE id = p_a FOR UPDATE; PERFORM 1 FROM public.app_user WHERE id = p_b FOR UPDATE;
 ELSE PERFORM 1 FROM public.app_user WHERE id = p_b FOR UPDATE; PERFORM 1 FROM public.app_user WHERE id = p_a FOR UPDATE; END IF;
END $$;
--> statement-breakpoint
-- Revalida o ator pela sessão: full, versão atual, ativo, sem troca pendente; escrita exige admin, leitura admin ou team. Em escrita trava ator+alvo em ordem de UUID ANTES de reavaliar.
CREATE OR REPLACE FUNCTION internal.admin_actor(p_digest text, p_write boolean, p_target uuid DEFAULT NULL, OUT o_actor uuid, OUT o_reason text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_uid uuid; u public.app_user%ROWTYPE; s public.auth_session%ROWTYPE; v_roles text[];
BEGIN
 SELECT user_id INTO v_uid FROM public.auth_session WHERE token_hash = p_digest;
 IF NOT FOUND THEN o_reason := 'auth_required'; RETURN; END IF;
 IF p_write THEN PERFORM internal.lock_users(v_uid, p_target); END IF;
 SELECT * INTO u FROM public.app_user WHERE id = v_uid;
 SELECT * INTO s FROM public.auth_session WHERE token_hash = p_digest;
 IF NOT FOUND OR s.revoked_at IS NOT NULL OR s.expires_at <= now() OR s.scope <> 'full' OR s.session_version <> u.session_version OR u.status <> 'active' OR u.must_change_password THEN
  o_reason := 'auth_required'; RETURN;
 END IF;
 v_roles := COALESCE((SELECT array_agg(r.role) FROM public.user_role r WHERE r.user_id = v_uid), ARRAY[]::text[]);
 IF p_write AND NOT ('admin' = ANY (v_roles)) THEN o_reason := 'forbidden'; RETURN; END IF;
 IF NOT p_write AND NOT (v_roles && ARRAY['admin','team']) THEN o_reason := 'forbidden'; RETURN; END IF;
 o_actor := v_uid; o_reason := 'ok';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.account_result(p_outcome text, p_id uuid)
RETURNS TABLE(o_outcome text, o_id uuid, o_email text, o_status text, o_roles text[], o_version bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT p_outcome, u.id, u.email, u.status, ARRAY(SELECT r.role FROM public.user_role r WHERE r.user_id = u.id AND r.role IN ('participant','mentor') ORDER BY r.role), u.version
  FROM public.app_user u WHERE u.id = p_id
 UNION ALL SELECT p_outcome, NULL::uuid, NULL::text, NULL::text, NULL::text[], NULL::bigint WHERE p_id IS NULL;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.user_has_active_enrollment(p_user uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM public.enrollment e JOIN public.participant d ON d.id = e.participant_id WHERE d.user_id = p_user AND e.status = 'active')
     OR EXISTS (SELECT 1 FROM public.enrollment e JOIN public.cohort c ON c.id = e.cohort_id JOIN public.mentor_topic mt ON mt.id = c.mentor_topic_id JOIN public.mentor m ON m.id = mt.mentor_id WHERE m.user_id = p_user AND e.status = 'active');
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.role_has_active_enrollment(p_user uuid, p_role text) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT CASE p_role
  WHEN 'participant' THEN EXISTS (SELECT 1 FROM public.enrollment e JOIN public.participant d ON d.id = e.participant_id WHERE d.user_id = p_user AND e.status = 'active')
  WHEN 'mentor' THEN EXISTS (SELECT 1 FROM public.enrollment e JOIN public.cohort c ON c.id = e.cohort_id JOIN public.mentor_topic mt ON mt.id = c.mentor_topic_id JOIN public.mentor m ON m.id = mt.mentor_id WHERE m.user_id = p_user AND e.status = 'active')
  ELSE false END;
$$;
--> statement-breakpoint
-- Destino já existente (usuário, linha de domínio com qualquer dono ou chave privilegiada): indisponível, sem dizer qual.
CREATE OR REPLACE FUNCTION internal.email_destination_taken(p_email text, p_except uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT EXISTS (SELECT 1 FROM public.app_user o WHERE o.email_key = lower(btrim(p_email)) AND o.id IS DISTINCT FROM p_except)
     OR EXISTS (SELECT 1 FROM public.participant d WHERE lower(btrim(d.email)) = lower(btrim(p_email)) AND (p_except IS NULL OR d.user_id IS DISTINCT FROM p_except))
     OR EXISTS (SELECT 1 FROM public.mentor d WHERE lower(btrim(d.email)) = lower(btrim(p_email)) AND (p_except IS NULL OR d.user_id IS DISTINCT FROM p_except))
     OR lower(btrim(p_email)) IN (SELECT k.ekey FROM internal.privileged_email_keys() k);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.idem_begin(p_actor_key text, p_method text, p_path text, p_key_hash text, p_request_hash text)
RETURNS TABLE(o_state text, o_id uuid, o_resource text, o_status integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_id uuid; r public.api_idempotency%ROWTYPE;
BEGIN
 IF p_actor_key IS NULL OR p_key_hash !~ '^[a-f0-9]{64}$' OR p_request_hash !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'invalid idempotency scope'; END IF;
 FOR i IN 1..3 LOOP
  DELETE FROM public.api_idempotency WHERE actor_key = p_actor_key AND method = p_method AND path = p_path AND key_hash = p_key_hash AND expires_at <= now();
  v_id := NULL;
  INSERT INTO public.api_idempotency(id, actor_key, method, path, key_hash, request_hash, expires_at)
   VALUES (gen_random_uuid(), p_actor_key, p_method, p_path, p_key_hash, p_request_hash, now() + interval '24 hours')
   ON CONFLICT ON CONSTRAINT api_idempotency_scope_unique DO NOTHING RETURNING id INTO v_id;
  IF v_id IS NOT NULL THEN RETURN QUERY SELECT 'new'::text, v_id, NULL::text, NULL::integer; RETURN; END IF;
  SELECT * INTO r FROM public.api_idempotency WHERE actor_key = p_actor_key AND method = p_method AND path = p_path AND key_hash = p_key_hash;
  IF FOUND THEN
   RETURN QUERY SELECT CASE WHEN r.request_hash = p_request_hash THEN 'replay' ELSE 'conflict' END::text, r.id, r.resource_id, r.status_code; RETURN;
  END IF;
 END LOOP;
 RAISE EXCEPTION 'idempotency unavailable';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.idem_finish(p_id uuid, p_resource text, p_status integer) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 UPDATE public.api_idempotency SET resource_id = p_resource, status_code = p_status WHERE id = p_id AND resource_id IS NULL AND status_code IS NULL;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.idem_abort(p_id uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 DELETE FROM public.api_idempotency WHERE id = p_id AND resource_id IS NULL AND status_code IS NULL;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.admin_user_list(p_digest text, p_after uuid, p_limit integer)
RETURNS TABLE(o_outcome text, o_id uuid, o_email text, o_status text, o_roles text[], o_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM internal.admin_actor(p_digest, false, NULL);
 IF a.o_reason <> 'ok' THEN RETURN QUERY SELECT * FROM internal.account_result(a.o_reason, NULL); RETURN; END IF;
 RETURN QUERY SELECT 'ok'::text, u.id, u.email, u.status, ARRAY(SELECT r.role FROM public.user_role r WHERE r.user_id = u.id AND r.role IN ('participant','mentor') ORDER BY r.role), u.version
  FROM public.app_user u WHERE (p_after IS NULL OR u.id > p_after) AND NOT internal.user_protected(u.id)
  ORDER BY u.id LIMIT greatest(1, least(coalesce(p_limit, 20), 101));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.admin_user_get(p_digest text, p_id uuid)
RETURNS TABLE(o_outcome text, o_id uuid, o_email text, o_status text, o_roles text[], o_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM internal.admin_actor(p_digest, false, NULL);
 IF a.o_reason <> 'ok' THEN RETURN QUERY SELECT * FROM internal.account_result(a.o_reason, NULL); RETURN; END IF;
 IF p_id IS NOT NULL AND EXISTS (SELECT 1 FROM public.app_user WHERE id = p_id) AND NOT internal.user_protected(p_id) THEN
  RETURN QUERY SELECT * FROM internal.account_result('ok', p_id);
 ELSE RETURN QUERY SELECT * FROM internal.account_result('not_found', NULL); END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.admin_user_update(p_digest text, p_id uuid, p_version bigint, p_patch jsonb, p_request uuid)
RETURNS TABLE(o_outcome text, o_id uuid, o_email text, o_status text, o_roles text[], o_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; u public.app_user%ROWTYPE;
 v_fields text[] := ARRAY[]::text[]; v_email text; v_status text; v_roles text[]; v_cur text[]; v_add text[]; v_remove text[];
 v_new_email text; v_new_status text; v_reset boolean := false; v_role text; v_status_changed boolean := false; v_roles_changed boolean := false;
BEGIN
 SELECT * INTO a FROM internal.admin_actor(p_digest, true, p_id);
 IF a.o_reason <> 'ok' THEN RETURN QUERY SELECT * FROM internal.account_result(a.o_reason, NULL); RETURN; END IF;
 SELECT * INTO u FROM public.app_user WHERE id = p_id;
 IF NOT FOUND OR internal.user_protected(p_id) THEN RETURN QUERY SELECT * FROM internal.account_result('not_found', NULL); RETURN; END IF;
 IF u.version IS DISTINCT FROM p_version THEN RETURN QUERY SELECT * FROM internal.account_result('version_mismatch', NULL); RETURN; END IF;
 IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' OR p_patch = '{}'::jsonb OR EXISTS (SELECT 1 FROM jsonb_object_keys(p_patch) k WHERE k NOT IN ('email','status','roles')) THEN
  RETURN QUERY SELECT * FROM internal.account_result('invalid', NULL); RETURN;
 END IF;
 IF p_patch ? 'status' THEN
  v_status := p_patch ->> 'status';
  IF jsonb_typeof(p_patch -> 'status') <> 'string' OR v_status NOT IN ('active','disabled') THEN RETURN QUERY SELECT * FROM internal.account_result('invalid', NULL); RETURN; END IF;
  IF v_status = 'disabled' AND u.status <> 'disabled' THEN v_new_status := 'disabled'; v_reset := true; v_status_changed := true;
  ELSIF v_status = 'active' AND u.status = 'disabled' THEN v_new_status := CASE WHEN u.password_hash IS NULL THEN 'pending_activation' ELSE 'active' END; v_status_changed := true; END IF;
 END IF;
 IF p_patch ? 'email' THEN
  IF jsonb_typeof(p_patch -> 'email') <> 'string' THEN RETURN QUERY SELECT * FROM internal.account_result('invalid', NULL); RETURN; END IF;
  v_email := btrim(p_patch ->> 'email');
  IF length(v_email) NOT BETWEEN 3 AND 254 OR v_email !~ '^[\x21-\x7e]+@[^@\s]+\.[^@\s]+$' THEN RETURN QUERY SELECT * FROM internal.account_result('invalid', NULL); RETURN; END IF;
  IF v_email <> u.email THEN
   IF internal.email_destination_taken(v_email, p_id) THEN RETURN QUERY SELECT * FROM internal.account_result('email_unavailable', NULL); RETURN; END IF;
   v_new_email := v_email; v_reset := true;
   IF coalesce(v_new_status, u.status) <> 'disabled' THEN v_new_status := 'pending_activation'; END IF;
  END IF;
 END IF;
 IF p_patch ? 'roles' THEN
  IF jsonb_typeof(p_patch -> 'roles') <> 'array' THEN RETURN QUERY SELECT * FROM internal.account_result('invalid', NULL); RETURN; END IF;
  v_roles := ARRAY(SELECT jsonb_array_elements_text(p_patch -> 'roles'));
  IF EXISTS (SELECT 1 FROM unnest(v_roles) r WHERE r NOT IN ('participant','mentor')) OR cardinality(v_roles) <> (SELECT count(DISTINCT r) FROM unnest(v_roles) r) THEN
   RETURN QUERY SELECT * FROM internal.account_result('invalid', NULL); RETURN;
  END IF;
  v_cur := ARRAY(SELECT r.role FROM public.user_role r WHERE r.user_id = p_id AND r.role IN ('participant','mentor'));
  v_add := ARRAY(SELECT unnest(v_roles) EXCEPT SELECT unnest(v_cur));
  v_remove := ARRAY(SELECT unnest(v_cur) EXCEPT SELECT unnest(v_roles));
  IF ('participant' = ANY (v_add) AND NOT EXISTS (SELECT 1 FROM public.participant WHERE user_id = p_id))
   OR ('mentor' = ANY (v_add) AND NOT EXISTS (SELECT 1 FROM public.mentor WHERE user_id = p_id)) THEN
   RETURN QUERY SELECT * FROM internal.account_result('invalid', NULL); RETURN;
  END IF;
  v_roles_changed := cardinality(v_add) + cardinality(v_remove) > 0;
 END IF;
 IF cardinality(coalesce(v_remove, ARRAY[]::text[])) > 0 OR v_new_status = 'disabled' THEN
  PERFORM 1 FROM internal.agenda_guard WHERE id = 1 FOR UPDATE;
  IF v_new_status = 'disabled' THEN
   IF internal.user_has_active_enrollment(p_id) THEN RETURN QUERY SELECT * FROM internal.account_result('conflict_active', NULL); RETURN; END IF;
  ELSE
   FOREACH v_role IN ARRAY v_remove LOOP
    IF internal.role_has_active_enrollment(p_id, v_role) THEN RETURN QUERY SELECT * FROM internal.account_result('conflict_active', NULL); RETURN; END IF;
   END LOOP;
  END IF;
 END IF;
 IF v_new_email IS NOT NULL THEN v_fields := array_append(v_fields, 'email'); END IF;
 IF v_status_changed THEN v_fields := array_append(v_fields, 'status'); END IF;
 IF v_roles_changed THEN v_fields := array_append(v_fields, 'roles'); END IF;
 IF cardinality(v_fields) = 0 THEN RETURN QUERY SELECT * FROM internal.account_result('ok', p_id); RETURN; END IF;
 BEGIN
  UPDATE public.app_user SET email = coalesce(v_new_email, email), status = coalesce(v_new_status, status),
   temporary_password_hash = CASE WHEN v_reset THEN NULL ELSE temporary_password_hash END,
   temporary_expires_at = CASE WHEN v_reset THEN NULL ELSE temporary_expires_at END,
   temporary_used_at = CASE WHEN v_reset THEN NULL ELSE temporary_used_at END,
   credential_generation = credential_generation + CASE WHEN v_reset THEN 1 ELSE 0 END,
   session_version = session_version + CASE WHEN v_reset THEN 1 ELSE 0 END
   WHERE id = p_id RETURNING * INTO u;
  IF v_reset THEN
   UPDATE public.auth_session SET revoked_at = now() WHERE user_id = p_id AND revoked_at IS NULL;
   UPDATE public.password_reset_token SET revoked_at = now() WHERE user_id = p_id AND used_at IS NULL AND revoked_at IS NULL;
   PERFORM internal.cancel_identity_jobs(p_id, CASE WHEN u.status = 'disabled' THEN ARRAY['registration','temporary_password','password_reset','reservation'] ELSE ARRAY['registration','temporary_password','password_reset'] END, ARRAY['queued','sending','unconfirmed']);
  END IF;
  IF cardinality(coalesce(v_remove, ARRAY[]::text[])) > 0 THEN DELETE FROM public.user_role WHERE user_id = p_id AND role = ANY (v_remove); END IF;
  IF cardinality(coalesce(v_add, ARRAY[]::text[])) > 0 THEN INSERT INTO public.user_role(user_id, role) SELECT p_id, r FROM unnest(v_add) r ON CONFLICT DO NOTHING; END IF;
  IF v_new_email IS NOT NULL AND u.status <> 'disabled' THEN
   INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key) VALUES (gen_random_uuid(), p_id, 'temporary_password', u.credential_generation, 'queued', 'email-change:' || p_id::text || ':' || gen_random_uuid()::text);
  END IF;
  INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id) VALUES (a.o_actor, 'user.update', 'user', p_id::text, to_jsonb(v_fields), 'ok', coalesce(p_request, gen_random_uuid()));
 EXCEPTION WHEN unique_violation THEN
  RETURN QUERY SELECT * FROM internal.account_result('email_unavailable', NULL); RETURN;
 END;
 RETURN QUERY SELECT * FROM internal.account_result('ok', p_id);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.admin_user_disable(p_digest text, p_id uuid, p_version bigint, p_request uuid)
RETURNS TABLE(o_outcome text, o_id uuid, o_email text, o_status text, o_roles text[], o_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; u public.app_user%ROWTYPE;
BEGIN
 SELECT * INTO a FROM internal.admin_actor(p_digest, true, p_id);
 IF a.o_reason <> 'ok' THEN RETURN QUERY SELECT * FROM internal.account_result(a.o_reason, NULL); RETURN; END IF;
 SELECT * INTO u FROM public.app_user WHERE id = p_id;
 IF NOT FOUND OR internal.user_protected(p_id) THEN RETURN QUERY SELECT * FROM internal.account_result('not_found', NULL); RETURN; END IF;
 IF u.version IS DISTINCT FROM p_version THEN RETURN QUERY SELECT * FROM internal.account_result('version_mismatch', NULL); RETURN; END IF;
 IF u.status = 'disabled' THEN RETURN QUERY SELECT * FROM internal.account_result('ok', p_id); RETURN; END IF;
 PERFORM 1 FROM internal.agenda_guard WHERE id = 1 FOR UPDATE;
 IF internal.user_has_active_enrollment(p_id) THEN RETURN QUERY SELECT * FROM internal.account_result('conflict_active', NULL); RETURN; END IF;
 UPDATE public.app_user SET status = 'disabled', temporary_password_hash = NULL, temporary_expires_at = NULL, temporary_used_at = NULL,
  credential_generation = credential_generation + 1, session_version = session_version + 1 WHERE id = p_id;
 UPDATE public.auth_session SET revoked_at = now() WHERE user_id = p_id AND revoked_at IS NULL;
 UPDATE public.password_reset_token SET revoked_at = now() WHERE user_id = p_id AND used_at IS NULL AND revoked_at IS NULL;
 PERFORM internal.cancel_identity_jobs(p_id, ARRAY['registration','temporary_password','password_reset','reservation'], ARRAY['queued','sending','unconfirmed']);
 INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id) VALUES (a.o_actor, 'user.disable', 'user', p_id::text, '["status"]'::jsonb, 'ok', coalesce(p_request, gen_random_uuid()));
 RETURN QUERY SELECT * FROM internal.account_result('ok', p_id);
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.admin_user_resend(p_digest text, p_id uuid, p_key uuid)
RETURNS TABLE(o_outcome text, o_job uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; u public.app_user%ROWTYPE; v_idem record; v_job uuid; v_path text; v_dedupe text;
BEGIN
 SELECT * INTO a FROM internal.admin_actor(p_digest, true, p_id);
 IF a.o_reason <> 'ok' THEN RETURN QUERY SELECT a.o_reason, NULL::uuid; RETURN; END IF;
 SELECT * INTO u FROM public.app_user WHERE id = p_id;
 IF p_key IS NULL OR NOT FOUND OR u.status = 'disabled' OR internal.user_protected(p_id) THEN RETURN QUERY SELECT 'not_found'::text, NULL::uuid; RETURN; END IF;
 v_path := '/api/v1/admin/users/' || p_id::text || '/temporary-password';
 SELECT * INTO v_idem FROM internal.idem_begin(a.o_actor::text, 'POST', v_path, encode(sha256(convert_to(p_key::text, 'UTF8')), 'hex'), encode(sha256(convert_to('POST ' || v_path || ' {"confirm":true}', 'UTF8')), 'hex'));
 IF v_idem.o_state = 'conflict' THEN RETURN QUERY SELECT 'idempotency_conflict'::text, NULL::uuid; RETURN; END IF;
 IF v_idem.o_state = 'replay' THEN RETURN QUERY SELECT 'ok'::text, v_idem.o_resource::uuid; RETURN; END IF;
 v_dedupe := 'resend:' || u.id::text || ':' || p_key::text;
 INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key) VALUES (gen_random_uuid(), u.id, 'temporary_password', u.credential_generation, 'queued', v_dedupe) ON CONFLICT (dedupe_key) DO NOTHING;
 SELECT j.id INTO v_job FROM public.email_job j WHERE j.dedupe_key = v_dedupe AND j.user_id = u.id;
 PERFORM internal.idem_finish(v_idem.o_id, v_job::text, 202);
 INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id) VALUES (a.o_actor, 'user.resend_temporary', 'user', p_id::text, '[]'::jsonb, 'ok', gen_random_uuid());
 RETURN QUERY SELECT 'ok'::text, v_job;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.admin_user_create(p_digest text, p_key uuid, p_request_hash text, p_email text, p_roles text[], p_participant jsonb, p_mentor jsonb, p_request uuid)
RETURNS TABLE(o_outcome text, o_id uuid, o_email text, o_status text, o_roles text[], o_version bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; v_idem record; v_email text := btrim(p_email); v_user uuid := gen_random_uuid(); v_out text; v_participant bigint;
BEGIN
 SELECT * INTO a FROM internal.admin_actor(p_digest, true, NULL);
 IF a.o_reason <> 'ok' THEN RETURN QUERY SELECT * FROM internal.account_result(a.o_reason, NULL); RETURN; END IF;
 IF p_key IS NULL OR p_request_hash IS NULL OR p_request_hash !~ '^[a-f0-9]{64}$' THEN RETURN QUERY SELECT * FROM internal.account_result('invalid', NULL); RETURN; END IF;
 SELECT * INTO v_idem FROM internal.idem_begin(a.o_actor::text, 'POST', '/api/v1/admin/users', encode(sha256(convert_to(p_key::text, 'UTF8')), 'hex'), p_request_hash);
 IF v_idem.o_state = 'conflict' THEN RETURN QUERY SELECT * FROM internal.account_result('idempotency_conflict', NULL); RETURN; END IF;
 IF v_idem.o_state = 'replay' THEN
  IF v_idem.o_resource IS NULL THEN RETURN QUERY SELECT * FROM internal.account_result('idempotency_conflict', NULL); RETURN; END IF;
  RETURN QUERY SELECT * FROM internal.account_result('ok', v_idem.o_resource::uuid); RETURN;
 END IF;
 IF v_email IS NULL OR length(v_email) NOT BETWEEN 3 AND 254 OR v_email !~ '^[\x21-\x7e]+@[^@\s]+\.[^@\s]+$' THEN v_out := 'invalid';
 ELSIF p_roles IS NULL OR cardinality(p_roles) = 0 OR EXISTS (SELECT 1 FROM unnest(p_roles) r WHERE r NOT IN ('participant','mentor')) OR cardinality(p_roles) <> (SELECT count(DISTINCT r) FROM unnest(p_roles) r)
  OR ('participant' = ANY (p_roles)) IS DISTINCT FROM (p_participant IS NOT NULL AND jsonb_typeof(p_participant) = 'object')
  OR ('mentor' = ANY (p_roles)) IS DISTINCT FROM (p_mentor IS NOT NULL AND jsonb_typeof(p_mentor) = 'object') THEN v_out := 'invalid';
 ELSIF p_participant IS NOT NULL AND (coalesce(p_participant ->> 'goal', '') NOT IN ('transition','growth','leadership') OR coalesce(p_participant ->> 'moment', '') NOT IN ('starting','working','returning')
  OR jsonb_typeof(p_participant -> 'interests') IS DISTINCT FROM 'array' OR jsonb_typeof(p_participant -> 'skills') IS DISTINCT FROM 'array' OR length(coalesce(p_participant ->> 'area', '')) NOT BETWEEN 1 AND 100) THEN v_out := 'invalid';
 ELSIF p_mentor IS NOT NULL AND (length(coalesce(btrim(p_mentor ->> 'displayName'), '')) NOT BETWEEN 1 AND 120 OR length(coalesce(btrim(p_mentor ->> 'trajectory'), '')) NOT BETWEEN 1 AND 1000
  OR length(coalesce(btrim(p_mentor ->> 'availability'), '')) NOT BETWEEN 1 AND 300 OR jsonb_typeof(p_mentor -> 'specialties') IS DISTINCT FROM 'array'
  OR jsonb_typeof(p_mentor -> 'legacyCapacity') IS DISTINCT FROM 'number' OR (p_mentor ->> 'legacyCapacity') !~ '^[0-9]{1,2}$' OR (p_mentor ->> 'legacyCapacity')::integer NOT BETWEEN 1 AND 50) THEN v_out := 'invalid';
 ELSIF internal.email_destination_taken(v_email, NULL) THEN v_out := 'email_unavailable';
 END IF;
 IF v_out IS NOT NULL THEN PERFORM internal.idem_abort(v_idem.o_id); RETURN QUERY SELECT * FROM internal.account_result(v_out, NULL); RETURN; END IF;
 BEGIN
  INSERT INTO public.app_user(id, email, status) VALUES (v_user, v_email, 'pending_activation');
  INSERT INTO public.user_role(user_id, role) SELECT v_user, r FROM unnest(p_roles) r;
  IF p_participant IS NOT NULL THEN
   INSERT INTO public.participant(email, goal, moment, interests, skills, area, token_hash, consent_version, consent_at, user_id)
    VALUES (v_email, p_participant ->> 'goal', p_participant ->> 'moment', p_participant -> 'interests', p_participant -> 'skills', p_participant ->> 'area',
     encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'), 'v1', now(), v_user) RETURNING id INTO v_participant;
  END IF;
  IF p_mentor IS NOT NULL THEN
   INSERT INTO public.mentor(email, trajectory, specialties, availability, capacity, active, demo, display_name, user_id, consent_version, consent_at)
    VALUES (v_email, btrim(p_mentor ->> 'trajectory'), p_mentor -> 'specialties', btrim(p_mentor ->> 'availability'), (p_mentor ->> 'legacyCapacity')::integer, true, false, btrim(p_mentor ->> 'displayName'), v_user, 'v1', now());
  END IF;
  INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key, participant_id) VALUES (gen_random_uuid(), v_user, 'registration', 0, 'queued', 'registration:' || v_user::text, v_participant);
  INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id) VALUES (a.o_actor, 'user.create', 'user', v_user::text, '["email","roles"]'::jsonb, 'ok', coalesce(p_request, gen_random_uuid()));
  PERFORM internal.idem_finish(v_idem.o_id, v_user::text, 201);
 EXCEPTION WHEN unique_violation THEN
  PERFORM internal.idem_abort(v_idem.o_id);
  RETURN QUERY SELECT * FROM internal.account_result('email_unavailable', NULL); RETURN;
 END;
 RETURN QUERY SELECT * FROM internal.account_result('ok', v_user);
END $$;
--> statement-breakpoint
-- O reenvio antigo também respeita o predicado de proteção (o HTTP usa admin_user_resend, que revalida o ator).
CREATE OR REPLACE FUNCTION internal.enqueue_admin_temporary(p_user uuid, p_key text) RETURNS TABLE(job_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u public.app_user%ROWTYPE; v_key text;
BEGIN
 IF p_key IS NULL OR p_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'invalid key'; END IF;
 SELECT * INTO u FROM public.app_user WHERE id = p_user FOR UPDATE;
 IF NOT FOUND OR u.status = 'disabled' THEN RETURN; END IF;
 IF internal.user_protected(u.id) THEN RETURN; END IF;
 v_key := 'resend:' || u.id::text || ':' || lower(p_key);
 INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key) VALUES (gen_random_uuid(), u.id, 'temporary_password', u.credential_generation, 'queued', v_key) ON CONFLICT (dedupe_key) DO NOTHING;
 RETURN QUERY SELECT j.id, j.status FROM public.email_job j WHERE j.dedupe_key = v_key AND j.user_id = u.id;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.migration_flagged_keys(boolean), internal.privileged_email_keys(), internal.collision_unresolved(text), internal.user_protected(uuid), internal.domain_protected(text,bigint),
 internal.lock_users(uuid,uuid), internal.admin_actor(text,boolean,uuid), internal.account_result(text,uuid), internal.user_has_active_enrollment(uuid), internal.role_has_active_enrollment(uuid,text),
 internal.email_destination_taken(text,uuid), internal.idem_begin(text,text,text,text,text), internal.idem_finish(uuid,text,integer), internal.idem_abort(uuid),
 internal.admin_user_list(text,uuid,integer), internal.admin_user_get(text,uuid), internal.admin_user_update(text,uuid,bigint,jsonb,uuid), internal.admin_user_disable(text,uuid,bigint,uuid),
 internal.admin_user_resend(text,uuid,uuid), internal.admin_user_create(text,uuid,text,text,text[],jsonb,jsonb,uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_runtime') THEN
  GRANT USAGE ON SCHEMA internal TO techwoman_runtime;
  GRANT EXECUTE ON FUNCTION internal.user_protected(uuid), internal.domain_protected(text,bigint),
   internal.admin_user_list(text,uuid,integer), internal.admin_user_get(text,uuid), internal.admin_user_update(text,uuid,bigint,jsonb,uuid), internal.admin_user_disable(text,uuid,bigint,uuid),
   internal.admin_user_resend(text,uuid,uuid), internal.admin_user_create(text,uuid,text,text,text[],jsonb,jsonb,uuid),
   internal.idem_begin(text,text,text,text,text), internal.idem_finish(uuid,text,integer), internal.idem_abort(uuid) TO techwoman_runtime;
 END IF;
 -- Fixtures/operador emitem credencial como dono; o worker usa só email_claim/email_emit_*.
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_mailer') THEN
  REVOKE EXECUTE ON FUNCTION internal.issue_temporary_credential(uuid,text), internal.issue_reset_token(uuid,text) FROM techwoman_mailer;
 END IF;
END $$;
