-- INT-003: compatibilidade serializada de confirmação de reserva, sem emissão de credencial.
-- Preserva assinatura, grants e comportamento dos três propósitos de identidade WP-002.
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
 -- Reserva: nenhum segredo/hash é aceito, nenhuma geração/sessão/credencial é alterada.
 -- Relê destino e vínculo em cada tentativa; a mensagem manda conferir o estado autenticado atual.
 IF j.kind = 'reservation' THEN
  IF p_hash IS NOT NULL THEN RAISE EXCEPTION 'reservation does not accept credential hash'; END IF;
  IF u.status <> 'active'
   OR EXISTS (SELECT 1 FROM public.user_role r WHERE r.user_id = u.id AND r.role IN ('admin','team'))
   OR NOT EXISTS (
    SELECT 1 FROM public.enrollment e JOIN public.participant p ON p.id=e.participant_id
    JOIN public.cohort c ON c.id=e.cohort_id
    WHERE e.id=j.enrollment_id AND e.participant_id=j.participant_id AND p.user_id=u.id
     AND p.active AND e.status='active' AND c.status IN ('open','closed') AND c.ends_at>now()
   ) THEN
   UPDATE public.email_job SET status='cancelled',lease_until=NULL,lease_owner=NULL,next_attempt_at=NULL,updated_at=now() WHERE id=p_job;
   RETURN QUERY SELECT 'cancelled'::text,NULL::text,NULL::text,NULL::bigint,NULL::uuid; RETURN;
  END IF;
  INSERT INTO public.email_delivery_attempt(id,job_id,generation,status)
   VALUES(gen_random_uuid(),p_job,j.generation,'sending') RETURNING id INTO v_att;
  RETURN QUERY SELECT 'issued'::text,u.email,j.kind,j.generation,v_att; RETURN;
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
