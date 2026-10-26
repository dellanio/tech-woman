-- WP-002 Task 2 (C): worker de e-mail R4. Ordem única de locks: app_user -> email_job (claim, begin, finish e cancelamentos).
-- Job não carrega payload/destino/segredo; o segredo só existe em memória do worker e o banco guarda hash.
CREATE OR REPLACE FUNCTION internal.identity_login_finish(p_user uuid, p_mode text, p_generation bigint, p_digest text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u public.app_user%ROWTYPE;
BEGIN
 SELECT * INTO u FROM public.app_user WHERE id=p_user FOR UPDATE;
 IF NOT FOUND OR u.credential_generation<>p_generation THEN RETURN NULL; END IF;
 IF p_mode='temporary' THEN
  IF NOT u.must_change_password OR u.status NOT IN ('active','pending_activation') OR u.temporary_password_hash IS NULL OR u.temporary_used_at IS NOT NULL OR u.temporary_expires_at<=now() THEN RETURN NULL; END IF;
  UPDATE public.app_user SET temporary_used_at=now(), credential_generation=credential_generation+1, updated_at=now() WHERE id=p_user;
  PERFORM internal.cancel_identity_jobs(p_user, ARRAY['temporary_password','registration'], ARRAY['queued','sending','unconfirmed']);
  INSERT INTO public.auth_session(id,user_id,token_hash,scope,session_version,expires_at) VALUES(gen_random_uuid(),p_user,p_digest,'password_change',u.session_version,now()+interval '10 minutes');
  RETURN 'password_change_required';
 ELSIF p_mode='password' THEN
  IF u.must_change_password OR u.status<>'active' OR u.password_hash IS NULL THEN RETURN NULL; END IF;
  -- só intenções automáticas (cadastro/forgot pendente) ficam obsoletas; reenvio administrativo explícito é intenção distinta
  PERFORM internal.cancel_identity_jobs(p_user, ARRAY['registration'], ARRAY['queued','sending','unconfirmed']);
  INSERT INTO public.auth_session(id,user_id,token_hash,scope,session_version,expires_at) VALUES(gen_random_uuid(),p_user,p_digest,'full',u.session_version,now()+interval '24 hours');
  RETURN 'authenticated';
 END IF;
 RETURN NULL;
END $$;
--> statement-breakpoint
-- Versão nua usada por fixtures: agora recusa alvo desativado ou privilegiado. O worker usa email_emit_begin.
CREATE OR REPLACE FUNCTION internal.issue_temporary_credential(p_user uuid, p_hash text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE g bigint; v_status text;
BEGIN
 SELECT status INTO v_status FROM public.app_user WHERE id=p_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'user not found'; END IF;
 IF v_status NOT IN ('active','pending_activation') OR EXISTS (SELECT 1 FROM public.user_role WHERE user_id=p_user AND role IN ('admin','team')) THEN RAISE EXCEPTION 'target not eligible'; END IF;
 UPDATE public.app_user SET temporary_password_hash=p_hash, temporary_expires_at=now()+interval '24 hours', temporary_used_at=NULL, must_change_password=true,
  credential_generation=credential_generation+1, session_version=session_version+1, updated_at=now(), version=version+1 WHERE id=p_user RETURNING credential_generation INTO g;
 UPDATE public.auth_session SET revoked_at=now() WHERE user_id=p_user AND revoked_at IS NULL;
 PERFORM internal.cancel_identity_jobs(p_user, ARRAY['temporary_password'], ARRAY['queued','unconfirmed']);
 RETURN g;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.email_claim(p_owner uuid) RETURNS TABLE(job_id uuid, kind text, attempt integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE c record; v_locked uuid; v_job public.email_job%ROWTYPE;
BEGIN
 FOR c IN
  SELECT t.user_id FROM (SELECT j.user_id, min(j.created_at) AS first_at FROM public.email_job j
   WHERE (j.status = 'queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= now()))
      OR (j.status = 'unconfirmed' AND j.attempts < 3 AND j.next_attempt_at <= now())
      OR (j.status = 'sending' AND j.lease_until < now())
   GROUP BY j.user_id) t ORDER BY t.first_at, t.user_id LIMIT 50
 LOOP
  SELECT u.id INTO v_locked FROM public.app_user u WHERE u.id = c.user_id FOR UPDATE SKIP LOCKED;
  IF v_locked IS NULL THEN CONTINUE; END IF;
  IF EXISTS (SELECT 1 FROM public.email_job j WHERE j.user_id = c.user_id AND j.status = 'sending' AND j.lease_until >= now()) THEN CONTINUE; END IF;
  UPDATE public.email_job j SET status = 'unconfirmed', lease_until = NULL, lease_owner = NULL, next_attempt_at = NULL, updated_at = now()
   WHERE j.user_id = c.user_id AND j.status = 'sending' AND j.lease_until < now() AND j.attempts >= 3;
  SELECT * INTO v_job FROM public.email_job j
   WHERE j.user_id = c.user_id AND ((j.status = 'queued' AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= now()))
      OR (j.status = 'unconfirmed' AND j.attempts < 3 AND j.next_attempt_at <= now())
      OR (j.status = 'sending' AND j.lease_until < now() AND j.attempts < 3))
   ORDER BY j.created_at, j.id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN CONTINUE; END IF;
  UPDATE public.email_job j SET status = 'sending', lease_until = now() + interval '60 seconds', lease_owner = p_owner, attempts = j.attempts + 1, next_attempt_at = NULL, updated_at = now() WHERE j.id = v_job.id;
  RETURN QUERY SELECT v_job.id, v_job.kind, v_job.attempts + 1;
  RETURN;
 END LOOP;
END $$;
--> statement-breakpoint
-- Revalida sob lock (usuário, geração, finalidade ainda pendente, admin/team, desativado) em TODA tentativa, emite hash e commita antes do transporte.
CREATE OR REPLACE FUNCTION internal.email_emit_begin(p_job uuid, p_owner uuid, p_hash text)
RETURNS TABLE(outcome text, destination text, kind text, generation bigint, attempt_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; j public.email_job%ROWTYPE; u public.app_user%ROWTYPE; v_temp boolean; v_retry boolean; v_obsolete boolean; v_gen bigint; v_att uuid;
BEGIN
 SELECT e.user_id INTO v_user FROM public.email_job e WHERE e.id = p_job;
 IF NOT FOUND THEN RETURN QUERY SELECT 'lost'::text, NULL::text, NULL::text, NULL::bigint, NULL::uuid; RETURN; END IF;
 SELECT * INTO u FROM public.app_user WHERE id = v_user FOR UPDATE;
 SELECT * INTO j FROM public.email_job WHERE id = p_job FOR UPDATE;
 IF j.status <> 'sending' OR j.lease_owner IS DISTINCT FROM p_owner OR j.lease_until < now() THEN
  RETURN QUERY SELECT 'lost'::text, NULL::text, NULL::text, NULL::bigint, NULL::uuid; RETURN;
 END IF;
 IF j.kind NOT IN ('registration','temporary_password','password_reset') THEN
  UPDATE public.email_job SET status = 'cancelled', lease_until = NULL, lease_owner = NULL, updated_at = now() WHERE id = p_job;
  RETURN QUERY SELECT 'cancelled'::text, NULL::text, NULL::text, NULL::bigint, NULL::uuid; RETURN;
 END IF;
 v_temp := j.kind IN ('registration','temporary_password');
 IF p_hash IS NULL OR (v_temp AND p_hash !~ '^[a-f0-9]{32}:[a-f0-9]{128}$') OR (NOT v_temp AND p_hash !~ '^[a-f0-9]{64}$') THEN RAISE EXCEPTION 'invalid credential hash'; END IF;
 v_retry := EXISTS (SELECT 1 FROM public.email_delivery_attempt a WHERE a.job_id = p_job);
 v_obsolete := u.status = 'disabled'
  OR (v_temp AND EXISTS (SELECT 1 FROM public.user_role r WHERE r.user_id = u.id AND r.role IN ('admin','team')))
  OR (j.kind = 'registration' AND u.status <> 'pending_activation')
  OR (j.kind = 'temporary_password' AND u.status NOT IN ('active','pending_activation'))
  OR (j.kind = 'password_reset' AND u.status <> 'active')
  OR (v_retry AND v_temp AND NOT (u.must_change_password AND u.temporary_password_hash IS NOT NULL AND u.temporary_used_at IS NULL AND u.temporary_expires_at > now() AND u.credential_generation = j.generation))
  OR (v_retry AND NOT v_temp AND NOT (u.credential_generation = j.generation AND EXISTS (SELECT 1 FROM public.password_reset_token t WHERE t.user_id = u.id AND t.used_at IS NULL AND t.revoked_at IS NULL AND t.expires_at > now() AND t.generation = j.generation)));
 IF v_obsolete THEN
  UPDATE public.email_job SET status = 'cancelled', lease_until = NULL, lease_owner = NULL, next_attempt_at = NULL, updated_at = now() WHERE id = p_job;
  RETURN QUERY SELECT 'cancelled'::text, NULL::text, NULL::text, NULL::bigint, NULL::uuid; RETURN;
 END IF;
 IF v_temp THEN
  UPDATE public.app_user SET temporary_password_hash = p_hash, temporary_expires_at = now() + interval '24 hours', temporary_used_at = NULL, must_change_password = true,
   credential_generation = credential_generation + 1, session_version = session_version + 1, updated_at = now(), version = version + 1 WHERE id = u.id RETURNING credential_generation INTO v_gen;
  UPDATE public.auth_session SET revoked_at = now() WHERE user_id = u.id AND revoked_at IS NULL;
  UPDATE public.password_reset_token SET revoked_at = now() WHERE user_id = u.id AND used_at IS NULL AND revoked_at IS NULL;
  PERFORM internal.cancel_identity_jobs(u.id, ARRAY['password_reset'], ARRAY['queued','sending','unconfirmed']);
 ELSE
  v_gen := u.credential_generation;
  UPDATE public.password_reset_token SET revoked_at = now() WHERE user_id = u.id AND used_at IS NULL AND revoked_at IS NULL;
  INSERT INTO public.password_reset_token(id, user_id, token_hash, generation, expires_at) VALUES (gen_random_uuid(), u.id, p_hash, v_gen, now() + interval '30 minutes');
 END IF;
 UPDATE public.email_job SET generation = v_gen, updated_at = now() WHERE id = p_job;
 INSERT INTO public.email_delivery_attempt(id, job_id, generation, status) VALUES (gen_random_uuid(), p_job, v_gen, 'sending') RETURNING id INTO v_att;
 RETURN QUERY SELECT 'issued'::text, u.email, j.kind, v_gen, v_att;
END $$;
--> statement-breakpoint
-- Metadados apenas: status do transporte, provider_id sanitizado e código da allowlist. A tentativa sempre registra o resultado real; o job só muda se lease/geração ainda forem atuais.
CREATE OR REPLACE FUNCTION internal.email_emit_finish(p_job uuid, p_owner uuid, p_attempt uuid, p_status text, p_provider text, p_error text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; v_gen bigint; v_err text; v_provider text; v_rows integer;
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('accepted','simulated','unconfirmed','failed') THEN RAISE EXCEPTION 'invalid status'; END IF;
 v_err := CASE WHEN p_error IN ('TRANSPORT_TIMEOUT','TRANSPORT_ERROR','TRANSPORT_REJECTED','RECIPIENT_NOT_ALLOWED','TRANSPORT_DISABLED') THEN p_error
               WHEN p_status IN ('unconfirmed','failed') THEN 'TRANSPORT_ERROR' ELSE NULL END;
 v_provider := CASE WHEN p_status = 'accepted' AND p_provider ~ '^[A-Za-z0-9._@-]{1,128}$' THEN p_provider ELSE NULL END;
 SELECT e.user_id INTO v_user FROM public.email_job e WHERE e.id = p_job;
 IF NOT FOUND THEN RETURN 'stale'; END IF;
 PERFORM 1 FROM public.app_user WHERE id = v_user FOR UPDATE;
 PERFORM 1 FROM public.email_job WHERE id = p_job FOR UPDATE;
 UPDATE public.email_delivery_attempt SET status = p_status, provider_id = v_provider, error_code = v_err, completed_at = now()
  WHERE id = p_attempt AND job_id = p_job AND completed_at IS NULL RETURNING generation INTO v_gen;
 IF NOT FOUND THEN RETURN 'stale'; END IF;
 UPDATE public.email_job SET status = p_status,
   next_attempt_at = CASE WHEN p_status = 'unconfirmed' THEN CASE attempts WHEN 1 THEN now() + interval '1 minute' WHEN 2 THEN now() + interval '5 minutes' ELSE NULL END ELSE NULL END,
   lease_until = NULL, lease_owner = NULL, updated_at = now()
  WHERE id = p_job AND status = 'sending' AND lease_owner = p_owner AND generation = v_gen;
 GET DIAGNOSTICS v_rows = ROW_COUNT;
 RETURN CASE WHEN v_rows = 1 THEN 'applied' ELSE 'stale' END;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.email_claim(uuid), internal.email_emit_begin(uuid,uuid,text), internal.email_emit_finish(uuid,uuid,uuid,text,text,text) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_mailer') THEN
  GRANT USAGE ON SCHEMA internal TO techwoman_mailer;
  GRANT EXECUTE ON FUNCTION internal.email_claim(uuid), internal.email_emit_begin(uuid,uuid,text), internal.email_emit_finish(uuid,uuid,uuid,text,text,text) TO techwoman_mailer;
 END IF;
END $$;
