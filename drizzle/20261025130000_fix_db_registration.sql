-- FIX-DB T1 (D-037, G3-02/T07/R3): cadastro público também recusa chave protegida presente SÓ no mapa da migração
-- (privileged_candidate, credential_conflict ou pendência não resolvida), sem app_user nem linha de domínio. Reusa o predicado conservador
-- existente (internal.privileged_email_keys, chave lower(btrim)) ANTES de qualquer INSERT: false sem mutação, 202 neutro idêntico no HTTP.
-- Mesmas assinaturas, retorno, owner e grants (CREATE OR REPLACE preserva ACL); corpo igual à última versão de cada função mais esse teste.
CREATE OR REPLACE FUNCTION internal.register_participant_account(p_email text, p_goal text, p_moment text, p_interests jsonb, p_skills jsonb, p_area text) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_email text := btrim(p_email); v_key text := lower(btrim(p_email)); v_user uuid := gen_random_uuid(); v_ins uuid; v_participant bigint;
BEGIN
 IF v_email IS NULL OR length(v_email) NOT BETWEEN 3 AND 254 OR v_email !~ '^[\x21-\x7e]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'invalid registration'; END IF;
 IF p_goal IS NULL OR p_goal NOT IN ('transition','growth','leadership') OR p_moment IS NULL OR p_moment NOT IN ('starting','working','returning')
  OR jsonb_typeof(p_interests) IS DISTINCT FROM 'array' OR jsonb_typeof(p_skills) IS DISTINCT FROM 'array' OR length(coalesce(p_area,'')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid registration'; END IF;
 IF EXISTS (SELECT 1 FROM public.participant WHERE user_id IS NULL AND lower(btrim(email)) = v_key)
  OR EXISTS (SELECT 1 FROM public.mentor WHERE user_id IS NULL AND lower(btrim(email)) = v_key)
  OR v_key IN (SELECT k.ekey FROM internal.privileged_email_keys() k) THEN RETURN false; END IF;
 INSERT INTO public.app_user(id, email, status) VALUES (v_user, v_email, 'pending_activation') ON CONFLICT ON CONSTRAINT app_user_email_key_unique DO NOTHING RETURNING id INTO v_ins;
 IF v_ins IS NULL THEN RETURN false; END IF;
 INSERT INTO public.user_role(user_id, role) VALUES (v_user, 'participant');
 INSERT INTO public.participant(email, goal, moment, interests, skills, area, token_hash, consent_version, consent_at, user_id)
  VALUES (v_email, p_goal, p_moment, p_interests, p_skills, p_area, encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'), 'v1', now(), v_user) RETURNING id INTO v_participant;
 INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key, participant_id)
  VALUES (gen_random_uuid(), v_user, 'registration', 0, 'queued', 'registration:' || v_user::text, v_participant);
 RETURN true;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.register_mentor_account(p_email text, p_display_name text, p_trajectory text, p_specialties jsonb, p_availability text, p_capacity integer) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_email text := btrim(p_email); v_key text := lower(btrim(p_email)); v_user uuid := gen_random_uuid(); v_ins uuid;
BEGIN
 IF v_email IS NULL OR length(v_email) NOT BETWEEN 3 AND 254 OR v_email !~ '^[\x21-\x7e]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'invalid registration'; END IF;
 IF (p_display_name IS NOT NULL AND length(btrim(p_display_name)) NOT BETWEEN 1 AND 120) OR length(coalesce(btrim(p_trajectory),'')) NOT BETWEEN 1 AND 1000 OR length(coalesce(btrim(p_availability),'')) NOT BETWEEN 1 AND 300
  OR jsonb_typeof(p_specialties) IS DISTINCT FROM 'array' OR p_capacity IS NULL OR p_capacity NOT BETWEEN 1 AND 50 THEN RAISE EXCEPTION 'invalid registration'; END IF;
 IF EXISTS (SELECT 1 FROM public.participant WHERE user_id IS NULL AND lower(btrim(email)) = v_key)
  OR EXISTS (SELECT 1 FROM public.mentor WHERE user_id IS NULL AND lower(btrim(email)) = v_key)
  OR v_key IN (SELECT k.ekey FROM internal.privileged_email_keys() k) THEN RETURN false; END IF;
 INSERT INTO public.app_user(id, email, status) VALUES (v_user, v_email, 'pending_activation') ON CONFLICT ON CONSTRAINT app_user_email_key_unique DO NOTHING RETURNING id INTO v_ins;
 IF v_ins IS NULL THEN RETURN false; END IF;
 INSERT INTO public.user_role(user_id, role) VALUES (v_user, 'mentor');
 INSERT INTO public.mentor(email, trajectory, specialties, availability, capacity, active, demo, display_name, user_id, consent_version, consent_at)
  VALUES (v_email, btrim(p_trajectory), p_specialties, btrim(p_availability), p_capacity, true, false, nullif(btrim(p_display_name), ''), v_user, 'v1', now());
 INSERT INTO public.email_job(id, user_id, kind, generation, status, dedupe_key)
  VALUES (gen_random_uuid(), v_user, 'registration', 0, 'queued', 'registration:' || v_user::text);
 RETURN true;
END $$;
