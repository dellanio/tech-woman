-- WP-002 Task 1: funções SECURITY DEFINER de identidade. Ordem de locks: app_user -> auth_session/password_reset_token -> email_job.
CREATE OR REPLACE FUNCTION internal.cancel_identity_jobs(p_user uuid, p_kinds text[], p_statuses text[]) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 UPDATE public.email_job SET status='cancelled', lease_until=NULL, lease_owner=NULL, updated_at=now()
 WHERE user_id=p_user AND kind=ANY(p_kinds) AND status=ANY(p_statuses);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.identity_login_begin(p_email text)
RETURNS TABLE(user_id uuid, mode text, hash text, generation bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT u.id,
  CASE WHEN u.must_change_password THEN 'temporary' ELSE 'password' END,
  CASE WHEN u.must_change_password THEN u.temporary_password_hash ELSE u.password_hash END,
  u.credential_generation
 FROM public.app_user u
 WHERE u.email_key=lower(btrim(p_email))
  AND CASE WHEN u.must_change_password
       THEN u.status IN ('active','pending_activation') AND u.temporary_password_hash IS NOT NULL AND u.temporary_used_at IS NULL AND u.temporary_expires_at>now()
       ELSE u.status='active' AND u.password_hash IS NOT NULL END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.identity_login_finish(p_user uuid, p_mode text, p_generation bigint, p_digest text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u public.app_user%ROWTYPE;
BEGIN
 SELECT * INTO u FROM public.app_user WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR u.credential_generation<>p_generation THEN RETURN NULL; END IF;
 IF p_mode='temporary' THEN
  IF NOT u.must_change_password OR u.status NOT IN ('active','pending_activation') OR u.temporary_password_hash IS NULL OR u.temporary_used_at IS NOT NULL OR u.temporary_expires_at<=now() THEN RETURN NULL; END IF;
  UPDATE public.app_user SET temporary_used_at=now(), credential_generation=credential_generation+1, updated_at=now() WHERE id=p_user;
  PERFORM internal.cancel_identity_jobs(p_user, ARRAY['temporary_password','registration'], ARRAY['queued','unconfirmed']);
  INSERT INTO public.auth_session(id,user_id,token_hash,scope,session_version,expires_at) VALUES(gen_random_uuid(),p_user,p_digest,'password_change',u.session_version,now()+interval '10 minutes');
  RETURN 'password_change_required';
 ELSIF p_mode='password' THEN
  IF u.must_change_password OR u.status<>'active' OR u.password_hash IS NULL THEN RETURN NULL; END IF;
  PERFORM internal.cancel_identity_jobs(p_user, ARRAY['temporary_password','registration'], ARRAY['queued','unconfirmed']);
  INSERT INTO public.auth_session(id,user_id,token_hash,scope,session_version,expires_at) VALUES(gen_random_uuid(),p_user,p_digest,'full',u.session_version,now()+interval '24 hours');
  RETURN 'authenticated';
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.identity_session_get(p_digest text)
RETURNS TABLE(id uuid, user_id uuid, email text, roles text[], scope text, expires_at timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT s.id, u.id, u.email, COALESCE((SELECT array_agg(r.role ORDER BY r.role) FROM public.user_role r WHERE r.user_id=u.id), ARRAY[]::text[]), s.scope, s.expires_at
 FROM public.auth_session s JOIN public.app_user u ON u.id=s.user_id
 WHERE s.token_hash=p_digest AND s.revoked_at IS NULL AND s.expires_at>now() AND s.session_version=u.session_version
  AND CASE s.scope WHEN 'full' THEN u.status='active' ELSE u.status IN ('active','pending_activation') AND u.must_change_password END;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.identity_change_begin(p_digest text)
RETURNS TABLE(user_id uuid, scope text, hash text, generation bigint)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 SELECT u.id, s.scope, CASE s.scope WHEN 'full' THEN u.password_hash ELSE u.temporary_password_hash END, u.credential_generation
 FROM public.auth_session s JOIN public.app_user u ON u.id=s.user_id
 WHERE s.token_hash=p_digest AND s.revoked_at IS NULL AND s.expires_at>now() AND s.session_version=u.session_version
  AND CASE s.scope WHEN 'full' THEN u.status='active' AND NOT u.must_change_password
       ELSE u.status IN ('active','pending_activation') AND u.must_change_password AND u.temporary_used_at IS NOT NULL END;
$$;
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
 INSERT INTO public.auth_session(id,user_id,token_hash,scope,session_version,expires_at) VALUES(gen_random_uuid(),uid,p_new_digest,'full',u.session_version+1,now()+interval '24 hours');
 RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.identity_logout(p_digest text) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
 UPDATE public.auth_session SET revoked_at=now() WHERE token_hash=p_digest AND revoked_at IS NULL;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.issue_temporary_credential(p_user uuid, p_hash text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE g bigint;
BEGIN
 PERFORM 1 FROM public.app_user WHERE id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
 UPDATE public.app_user SET temporary_password_hash=p_hash, temporary_expires_at=now()+interval '24 hours', temporary_used_at=NULL, must_change_password=true,
  credential_generation=credential_generation+1, session_version=session_version+1, updated_at=now(), version=version+1 WHERE id=p_user RETURNING credential_generation INTO g;
 UPDATE public.auth_session SET revoked_at=now() WHERE user_id=p_user AND revoked_at IS NULL;
 PERFORM internal.cancel_identity_jobs(p_user, ARRAY['temporary_password'], ARRAY['queued','unconfirmed']);
 RETURN g;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.issue_reset_token(p_user uuid, p_digest text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE g bigint;
BEGIN
 SELECT credential_generation INTO g FROM public.app_user WHERE id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
 UPDATE public.password_reset_token SET revoked_at=now() WHERE user_id=p_user AND used_at IS NULL AND revoked_at IS NULL;
 INSERT INTO public.password_reset_token(id,user_id,token_hash,generation,expires_at) VALUES(gen_random_uuid(),p_user,p_digest,g,now()+interval '30 minutes');
 RETURN g;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.consume_reset_token(p_digest text, p_new_hash text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE uid uuid; u public.app_user%ROWTYPE; t public.password_reset_token%ROWTYPE;
BEGIN
 SELECT user_id INTO uid FROM public.password_reset_token WHERE token_hash=p_digest;
 IF NOT FOUND THEN RETURN false; END IF;
 SELECT * INTO u FROM public.app_user WHERE id=uid FOR UPDATE;
 SELECT * INTO t FROM public.password_reset_token WHERE token_hash=p_digest FOR UPDATE;
 IF t.used_at IS NOT NULL OR t.revoked_at IS NOT NULL OR t.expires_at<=now() OR t.generation<>u.credential_generation OR u.status<>'active' THEN RETURN false; END IF;
 UPDATE public.password_reset_token SET used_at=now() WHERE id=t.id;
 UPDATE public.password_reset_token SET revoked_at=now() WHERE user_id=uid AND used_at IS NULL AND revoked_at IS NULL;
 UPDATE public.app_user SET password_hash=p_new_hash, temporary_password_hash=NULL, temporary_expires_at=NULL, temporary_used_at=NULL, must_change_password=false,
  session_version=session_version+1, credential_generation=credential_generation+1, updated_at=now(), version=version+1 WHERE id=uid;
 UPDATE public.auth_session SET revoked_at=now() WHERE user_id=uid AND revoked_at IS NULL;
 PERFORM internal.cancel_identity_jobs(uid, ARRAY['temporary_password','registration','password_reset'], ARRAY['queued','sending','unconfirmed']);
 RETURN true;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.cancel_identity_jobs(uuid,text[],text[]), internal.identity_login_begin(text), internal.identity_login_finish(uuid,text,bigint,text), internal.identity_session_get(text),
 internal.identity_change_begin(text), internal.identity_change_finish(text,bigint,text,text), internal.identity_logout(text),
 internal.issue_temporary_credential(uuid,text), internal.issue_reset_token(uuid,text), internal.consume_reset_token(text,text) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_runtime') THEN
  GRANT USAGE ON SCHEMA internal TO techwoman_runtime;
  GRANT EXECUTE ON FUNCTION internal.identity_login_begin(text), internal.identity_login_finish(uuid,text,bigint,text), internal.identity_session_get(text),
   internal.identity_change_begin(text), internal.identity_change_finish(text,bigint,text,text), internal.identity_logout(text), internal.consume_reset_token(text,text) TO techwoman_runtime;
 END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_mailer') THEN
  GRANT USAGE ON SCHEMA internal TO techwoman_mailer;
  GRANT EXECUTE ON FUNCTION internal.issue_temporary_credential(uuid,text), internal.issue_reset_token(uuid,text) TO techwoman_mailer;
 END IF;
END $$;
