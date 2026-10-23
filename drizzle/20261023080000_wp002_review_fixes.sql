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
