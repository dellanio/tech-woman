-- WP-002 revisão final: correções por RED/GREEN (migrations anteriores já aplicadas não são editadas).
-- I2: o service legado precisa travar o(s) dono(s) da linha de domínio ANTES do predicado, como o CRUD e a elevação offline (app_user FOR UPDATE).
CREATE OR REPLACE FUNCTION internal.lock_domain_owner(p_table text, p_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; v_key text;
BEGIN
 IF p_table = 'participant' THEN SELECT d.user_id, lower(btrim(d.email)) INTO v_user, v_key FROM public.participant d WHERE d.id = p_id;
 ELSIF p_table = 'mentor' THEN SELECT d.user_id, lower(btrim(d.email)) INTO v_user, v_key FROM public.mentor d WHERE d.id = p_id;
 ELSE RETURN; END IF;
 IF NOT FOUND THEN RETURN; END IF;
 -- FOR SHARE espera a elevação offline (FOR UPDATE) terminar; ordem por id evita deadlock entre lockers.
 PERFORM 1 FROM public.app_user a WHERE a.id = v_user OR a.email_key = v_key ORDER BY a.id FOR SHARE;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.lock_domain_owner(text,bigint) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.lock_domain_owner(text,bigint) TO techwoman_runtime;
 END IF;
END $$;
--> statement-breakpoint
-- M1: replay idempotente não devolve conta que virou protegida (admin/team).
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
  IF internal.user_protected(v_idem.o_resource::uuid) THEN RETURN QUERY SELECT * FROM internal.account_result('not_found', NULL); RETURN; END IF;
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
-- M3: o reenvio HTTP usa admin_user_resend (revalida o ator); a função nua sem checagem de ator não fica executável pelo app/worker.
REVOKE ALL ON FUNCTION internal.enqueue_admin_temporary(uuid,text) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_runtime') THEN REVOKE EXECUTE ON FUNCTION internal.enqueue_admin_temporary(uuid,text) FROM techwoman_runtime; END IF;
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_mailer') THEN REVOKE EXECUTE ON FUNCTION internal.enqueue_admin_temporary(uuid,text) FROM techwoman_mailer; END IF;
END $$;
--> statement-breakpoint
-- I1: forgot em pending_activation não destrói ativação em andamento; R-spec: terceira tentativa sem confirmação vira failed.
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.request_password_forgot(p_email text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE u public.app_user%ROWTYPE;
BEGIN
 IF p_email IS NULL OR length(p_email) > 320 THEN RETURN; END IF;
 SELECT * INTO u FROM public.app_user WHERE email_key = lower(btrim(p_email)) FOR UPDATE;
 IF NOT FOUND OR u.status = 'disabled' THEN RETURN; END IF;
 IF u.status = 'pending_activation' THEN
  IF EXISTS (SELECT 1 FROM public.user_role WHERE user_id = u.id AND role IN ('admin','team')) THEN RETURN; END IF;
  -- ativação em andamento: temporário já usado com sessão limitada viva, ou temporário válido emitido há menos de 15 minutos (reemissão com taxa)
  IF u.temporary_used_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.auth_session s WHERE s.user_id = u.id AND s.scope = 'password_change' AND s.revoked_at IS NULL AND s.expires_at > now() AND s.session_version = u.session_version) THEN RETURN; END IF;
  IF u.temporary_password_hash IS NOT NULL AND u.temporary_used_at IS NULL AND u.temporary_expires_at > now() + interval '23 hours 45 minutes' THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM public.email_job WHERE user_id = u.id AND kind IN ('registration','temporary_password') AND (status IN ('queued','sending') OR (status = 'unconfirmed' AND attempts < 3))) THEN RETURN; END IF;
  INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key) VALUES (gen_random_uuid(), u.id, 'registration', u.credential_generation, 'queued', 'forgot-temporary:' || gen_random_uuid()::text);
 ELSE
  IF EXISTS (SELECT 1 FROM public.email_job WHERE user_id = u.id AND kind = 'password_reset' AND (status IN ('queued','sending') OR (status = 'unconfirmed' AND attempts < 3))) THEN RETURN; END IF;
  INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key) VALUES (gen_random_uuid(), u.id, 'password_reset', u.credential_generation, 'queued', 'forgot-reset:' || gen_random_uuid()::text);
 END IF;
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
  UPDATE public.email_job j SET status = 'failed', lease_until = NULL, lease_owner = NULL, next_attempt_at = NULL, updated_at = now()
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
CREATE OR REPLACE FUNCTION internal.email_emit_begin(p_job uuid, p_owner uuid, p_hash text)
RETURNS TABLE(outcome text, destination text, kind text, generation bigint, attempt_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; j public.email_job%ROWTYPE; u public.app_user%ROWTYPE; v_temp boolean; v_retry boolean; v_obsolete boolean; v_limited boolean; v_gen bigint; v_att uuid;
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
 v_limited := u.temporary_used_at IS NOT NULL AND EXISTS (SELECT 1 FROM public.auth_session s WHERE s.user_id = u.id AND s.scope = 'password_change' AND s.revoked_at IS NULL AND s.expires_at > now() AND s.session_version = u.session_version);
 v_retry := EXISTS (SELECT 1 FROM public.email_delivery_attempt a WHERE a.job_id = p_job);
 v_obsolete := u.status = 'disabled'
  OR (v_temp AND EXISTS (SELECT 1 FROM public.user_role r WHERE r.user_id = u.id AND r.role IN ('admin','team')))
  OR (j.kind = 'registration' AND u.status <> 'pending_activation')
  OR (j.kind = 'registration' AND v_limited)
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
CREATE OR REPLACE FUNCTION internal.email_emit_finish(p_job uuid, p_owner uuid, p_attempt uuid, p_status text, p_provider text, p_error text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; v_gen bigint; v_err text; v_provider text; v_rows integer; v_attempts integer; v_status text;
BEGIN
 IF p_status IS NULL OR p_status NOT IN ('accepted','simulated','unconfirmed','failed') THEN RAISE EXCEPTION 'invalid status'; END IF;
 v_err := CASE WHEN p_error IN ('TRANSPORT_TIMEOUT','TRANSPORT_ERROR','TRANSPORT_REJECTED','RECIPIENT_NOT_ALLOWED','TRANSPORT_DISABLED') THEN p_error
               WHEN p_status IN ('unconfirmed','failed') THEN 'TRANSPORT_ERROR' ELSE NULL END;
 v_provider := CASE WHEN p_status = 'accepted' AND p_provider ~ '^[A-Za-z0-9._@-]{1,128}$' THEN p_provider ELSE NULL END;
 SELECT e.user_id INTO v_user FROM public.email_job e WHERE e.id = p_job;
 IF NOT FOUND THEN RETURN 'stale'; END IF;
 PERFORM 1 FROM public.app_user WHERE id = v_user FOR UPDATE;
 SELECT attempts INTO v_attempts FROM public.email_job WHERE id = p_job FOR UPDATE;
 -- retry em 1 e 5min; sem confirmação na terceira tentativa o job termina em failed
 v_status := CASE WHEN p_status = 'unconfirmed' AND v_attempts >= 3 THEN 'failed' ELSE p_status END;
 UPDATE public.email_delivery_attempt SET status = v_status, provider_id = v_provider, error_code = v_err, completed_at = now()
  WHERE id = p_attempt AND job_id = p_job AND completed_at IS NULL RETURNING generation INTO v_gen;
 IF NOT FOUND THEN RETURN 'stale'; END IF;
 UPDATE public.email_job SET status = v_status,
   next_attempt_at = CASE WHEN p_status = 'unconfirmed' THEN CASE attempts WHEN 1 THEN now() + interval '1 minute' WHEN 2 THEN now() + interval '5 minutes' ELSE NULL END ELSE NULL END,
   lease_until = NULL, lease_owner = NULL, updated_at = now()
  WHERE id = p_job AND status = 'sending' AND lease_owner = p_owner AND generation = v_gen;
 GET DIAGNOSTICS v_rows = ROW_COUNT;
 RETURN CASE WHEN v_rows <> 1 THEN 'stale' WHEN v_status <> p_status THEN 'failed' ELSE 'applied' END;
END $$;
--> statement-breakpoint
UPDATE public.email_job SET status = 'failed', updated_at = now() WHERE status = 'unconfirmed' AND attempts >= 3;
