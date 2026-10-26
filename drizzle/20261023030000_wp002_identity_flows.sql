-- WP-002 Task 2 (B): esqueci-senha, reenvio administrativo, perfil próprio e ativação legada. Ordem de locks: app_user -> agenda_guard -> domínio/jobs.
CREATE OR REPLACE FUNCTION internal.request_password_forgot(p_email text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u public.app_user%ROWTYPE;
BEGIN
 IF p_email IS NULL OR length(p_email) > 320 THEN RETURN; END IF;
 SELECT * INTO u FROM public.app_user WHERE email_key = lower(btrim(p_email)) FOR UPDATE;
 IF NOT FOUND OR u.status = 'disabled' THEN RETURN; END IF;
 IF u.status = 'pending_activation' THEN
  IF EXISTS (SELECT 1 FROM public.user_role WHERE user_id = u.id AND role IN ('admin','team')) THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.email_job WHERE user_id = u.id AND kind IN ('registration','temporary_password') AND (status IN ('queued','sending') OR (status = 'unconfirmed' AND attempts < 3))) THEN RETURN; END IF;
  INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key) VALUES (gen_random_uuid(), u.id, 'registration', u.credential_generation, 'queued', 'forgot-temporary:' || gen_random_uuid()::text);
 ELSE
  IF EXISTS (SELECT 1 FROM public.email_job WHERE user_id = u.id AND kind = 'password_reset' AND (status IN ('queued','sending') OR (status = 'unconfirmed' AND attempts < 3))) THEN RETURN; END IF;
  INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key) VALUES (gen_random_uuid(), u.id, 'password_reset', u.credential_generation, 'queued', 'forgot-reset:' || gen_random_uuid()::text);
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.enqueue_admin_temporary(p_user uuid, p_key text) RETURNS TABLE(job_id uuid, status text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u public.app_user%ROWTYPE; v_key text;
BEGIN
 IF p_key IS NULL OR p_key !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION 'invalid key'; END IF;
 SELECT * INTO u FROM public.app_user WHERE id = p_user FOR UPDATE;
 IF NOT FOUND OR u.status = 'disabled' THEN RETURN; END IF;
 IF EXISTS (SELECT 1 FROM public.user_role WHERE user_id = u.id AND role IN ('admin','team')) THEN RETURN; END IF;
 v_key := 'resend:' || u.id::text || ':' || lower(p_key);
 INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key) VALUES (gen_random_uuid(), u.id, 'temporary_password', u.credential_generation, 'queued', v_key) ON CONFLICT (dedupe_key) DO NOTHING;
 RETURN QUERY SELECT j.id, j.status FROM public.email_job j WHERE j.dedupe_key = v_key AND j.user_id = u.id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.add_own_participant_profile(p_digest text, p_goal text, p_moment text, p_interests jsonb, p_skills jsonb, p_area text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_uid uuid; u public.app_user%ROWTYPE;
BEGIN
 SELECT user_id INTO v_uid FROM public.auth_session WHERE token_hash = p_digest AND scope = 'full' AND revoked_at IS NULL AND expires_at > now();
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 SELECT * INTO u FROM public.app_user WHERE id = v_uid FOR UPDATE;
 IF NOT FOUND OR u.status <> 'active' OR u.must_change_password
  OR NOT EXISTS (SELECT 1 FROM public.auth_session s WHERE s.token_hash = p_digest AND s.scope = 'full' AND s.revoked_at IS NULL AND s.expires_at > now() AND s.session_version = u.session_version)
  OR EXISTS (SELECT 1 FROM public.user_role WHERE user_id = u.id AND role IN ('admin','team')) THEN RETURN 'not_found'; END IF;
 IF p_goal IS NULL OR p_goal NOT IN ('transition','growth','leadership') OR p_moment IS NULL OR p_moment NOT IN ('starting','working','returning')
  OR jsonb_typeof(p_interests) IS DISTINCT FROM 'array' OR jsonb_typeof(p_skills) IS DISTINCT FROM 'array' OR length(coalesce(p_area,'')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid profile'; END IF;
 IF EXISTS (SELECT 1 FROM public.participant WHERE user_id = u.id) THEN RETURN 'conflict'; END IF;
 IF EXISTS (SELECT 1 FROM public.participant WHERE user_id IS NULL AND lower(btrim(email)) = u.email_key)
  OR EXISTS (SELECT 1 FROM public.mentor WHERE user_id IS NULL AND lower(btrim(email)) = u.email_key) THEN RETURN 'reconciliation'; END IF;
 INSERT INTO public.participant(email, goal, moment, interests, skills, area, token_hash, consent_version, consent_at, user_id)
  VALUES (u.email, p_goal, p_moment, p_interests, p_skills, p_area, encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'), 'v1', now(), u.id);
 INSERT INTO public.user_role(user_id, role) VALUES (u.id, 'participant') ON CONFLICT DO NOTHING;
 RETURN 'created';
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.add_own_mentor_profile(p_digest text, p_display_name text, p_trajectory text, p_specialties jsonb, p_availability text, p_capacity integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_uid uuid; u public.app_user%ROWTYPE;
BEGIN
 SELECT user_id INTO v_uid FROM public.auth_session WHERE token_hash = p_digest AND scope = 'full' AND revoked_at IS NULL AND expires_at > now();
 IF NOT FOUND THEN RETURN 'not_found'; END IF;
 SELECT * INTO u FROM public.app_user WHERE id = v_uid FOR UPDATE;
 IF NOT FOUND OR u.status <> 'active' OR u.must_change_password
  OR NOT EXISTS (SELECT 1 FROM public.auth_session s WHERE s.token_hash = p_digest AND s.scope = 'full' AND s.revoked_at IS NULL AND s.expires_at > now() AND s.session_version = u.session_version)
  OR EXISTS (SELECT 1 FROM public.user_role WHERE user_id = u.id AND role IN ('admin','team')) THEN RETURN 'not_found'; END IF;
 IF length(coalesce(btrim(p_display_name),'')) NOT BETWEEN 1 AND 120 OR length(coalesce(btrim(p_trajectory),'')) NOT BETWEEN 1 AND 1000 OR length(coalesce(btrim(p_availability),'')) NOT BETWEEN 1 AND 300
  OR jsonb_typeof(p_specialties) IS DISTINCT FROM 'array' OR p_capacity IS NULL OR p_capacity NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'invalid profile'; END IF;
 IF EXISTS (SELECT 1 FROM public.mentor WHERE user_id = u.id) THEN RETURN 'conflict'; END IF;
 IF EXISTS (SELECT 1 FROM public.participant WHERE user_id IS NULL AND lower(btrim(email)) = u.email_key)
  OR EXISTS (SELECT 1 FROM public.mentor WHERE user_id IS NULL AND lower(btrim(email)) = u.email_key) THEN RETURN 'reconciliation'; END IF;
 INSERT INTO public.mentor(email, trajectory, specialties, availability, capacity, active, demo, display_name, user_id, consent_version, consent_at)
  VALUES (u.email, btrim(p_trajectory), p_specialties, btrim(p_availability), p_capacity, true, false, btrim(p_display_name), u.id, 'v1', now());
 INSERT INTO public.user_role(user_id, role) VALUES (u.id, 'mentor') ON CONFLICT DO NOTHING;
 RETURN 'created';
END $$;
--> statement-breakpoint
-- Lê o mapa privado sem conceder SELECT ao runtime; só é chamada de dentro da troca inicial comprovada (identity_change_finish).
CREATE OR REPLACE FUNCTION internal.activate_legacy_identity(p_user uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u public.app_user%ROWTYPE; v_table text; v_keys bigint[]; v_id bigint; v_rows integer; v_count integer := 0;
BEGIN
 SELECT * INTO u FROM public.app_user WHERE id = p_user FOR UPDATE;
 IF NOT FOUND OR u.status <> 'active' THEN RETURN 0; END IF;
 IF EXISTS (SELECT 1 FROM public.user_role WHERE user_id = p_user AND role IN ('admin','team')) THEN RETURN 0; END IF;
 PERFORM 1 FROM internal.agenda_guard WHERE id = 1 FOR UPDATE;
 FOREACH v_table IN ARRAY ARRAY['participant','mentor'] LOOP
  SELECT coalesce(array_agg(l.source_key::bigint), ARRAY[]::bigint[]) INTO v_keys FROM public.migration_identity_link l
   WHERE l.user_id = p_user AND l.resolution = 'awaiting_email_proof' AND l.source_table = v_table AND l.source_key ~ '^[0-9]{1,18}$';
  IF cardinality(v_keys) <> 1 THEN CONTINUE; END IF;
  v_id := v_keys[1];
  IF v_table = 'participant' THEN
   IF EXISTS (SELECT 1 FROM public.participant WHERE user_id = p_user) THEN CONTINUE; END IF;
   IF EXISTS (SELECT 1 FROM public.participant WHERE user_id IS NULL AND id <> v_id AND lower(btrim(email)) = u.email_key) THEN CONTINUE; END IF;
   UPDATE public.participant SET user_id = p_user, legacy_access_revoked_at = now() WHERE id = v_id AND user_id IS NULL AND legacy_access_revoked_at IS NULL AND lower(btrim(email)) = u.email_key;
  ELSE
   IF EXISTS (SELECT 1 FROM public.mentor WHERE user_id = p_user) THEN CONTINUE; END IF;
   IF EXISTS (SELECT 1 FROM public.mentor WHERE user_id IS NULL AND id <> v_id AND lower(btrim(email)) = u.email_key) THEN CONTINUE; END IF;
   UPDATE public.mentor SET user_id = p_user WHERE id = v_id AND user_id IS NULL AND lower(btrim(email)) = u.email_key;
  END IF;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN CONTINUE; END IF;
  INSERT INTO public.user_role(user_id, role) VALUES (p_user, v_table) ON CONFLICT DO NOTHING;
  UPDATE public.migration_identity_link SET resolution = 'activated' WHERE user_id = p_user AND source_table = v_table AND source_key = v_id::text AND resolution = 'awaiting_email_proof';
  v_count := v_count + 1;
 END LOOP;
 IF v_count > 0 THEN UPDATE internal.agenda_guard SET revision = revision + 1 WHERE id = 1; END IF;
 RETURN v_count;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.identity_change_finish(p_digest text, p_generation bigint, p_new_hash text, p_new_digest text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE uid uuid; u public.app_user%ROWTYPE; s public.auth_session%ROWTYPE;
BEGIN
 SELECT user_id INTO uid FROM public.auth_session WHERE token_hash=p_digest;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO u FROM public.app_user WHERE id=uid FOR UPDATE;
 SELECT * INTO s FROM public.auth_session WHERE token_hash=p_digest FOR UPDATE;
 IF s.revoked_at IS NOT NULL OR s.expires_at<=now() OR s.session_version<>u.session_version OR u.credential_generation<>p_generation THEN RETURN false; END IF;
 IF s.scope='full' THEN
  IF u.status<>'active' OR u.must_change_password THEN RETURN false; END IF;
 ELSE
  IF u.status NOT IN ('active','pending_activation') OR NOT u.must_change_password OR u.temporary_used_at IS NULL THEN RETURN false; END IF;
 END IF;
 UPDATE public.app_user SET password_hash=p_new_hash, temporary_password_hash=NULL, temporary_expires_at=NULL, temporary_used_at=NULL, must_change_password=false,
  status='active', session_version=session_version+1, credential_generation=credential_generation+1, updated_at=now(), version=version+1 WHERE id=uid;
 UPDATE public.auth_session SET revoked_at=now() WHERE user_id=uid AND revoked_at IS NULL;
 UPDATE public.password_reset_token SET revoked_at=now() WHERE user_id=uid AND used_at IS NULL AND revoked_at IS NULL;
 PERFORM internal.cancel_identity_jobs(uid, ARRAY['temporary_password','registration','password_reset'], ARRAY['queued','sending','unconfirmed']);
 IF s.scope='password_change' THEN PERFORM internal.activate_legacy_identity(uid); END IF;
 INSERT INTO public.auth_session(id,user_id,token_hash,scope,session_version,expires_at) VALUES(gen_random_uuid(),uid,p_new_digest,'full',u.session_version+1,now()+interval '24 hours');
 RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.request_password_forgot(text), internal.enqueue_admin_temporary(uuid,text),
 internal.add_own_participant_profile(text,text,text,jsonb,jsonb,text), internal.add_own_mentor_profile(text,text,text,jsonb,text,integer), internal.activate_legacy_identity(uuid) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_runtime') THEN
  GRANT USAGE ON SCHEMA internal TO techwoman_runtime;
  GRANT EXECUTE ON FUNCTION internal.request_password_forgot(text), internal.enqueue_admin_temporary(uuid,text),
   internal.add_own_participant_profile(text,text,text,jsonb,jsonb,text), internal.add_own_mentor_profile(text,text,text,jsonb,text,integer) TO techwoman_runtime;
 END IF;
END $$;
