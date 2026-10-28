-- AJUSTE-INSCRICAO (t_e5584a38): crossing antes das credenciais e senha definitiva no cadastro público de participante.
-- 1. Ranking legado por VALORES (internal.agenda_ranking_values): mesmo corpo/semântica de internal.agenda_ranking, que passa a delegar a ele
--    (CREATE OR REPLACE preserva owner/ACL). O preview calcula o ranking sem criar perfil temporário.
-- 2. internal.registration_candidates: compatíveis = mentora ativa, não protegida e score > 0; independe de turma/capacidade; ordem score desc, id.
--    Nome público: display_name; sem display_name → literalmente '(MENTORA)' (decisão do sponsor de 28/10; demo_name nunca entra).
-- 3. internal.registration_preview (SECURITY DEFINER, STABLE): só lê; devolve [{id,name}] ao servidor, que troca o id por referência opaca (HMAC).
-- 4. internal.register_participant_account muda de assinatura (DROP explícito): conta active com password_hash (scrypt do app), perfil e match
--    current 'suggested' da mentora escolhida, revalidada sob lock ANTES do e-mail; anti-enumeração igual à anterior; nenhum email_job.
-- Fluxos admin create/resend, recuperação e worker: intocados.
CREATE OR REPLACE FUNCTION internal.agenda_ranking_values(p_goal text, p_interests jsonb, p_skills jsonb, p_area text, p_mentor bigint, OUT o_score integer, OUT o_reasons jsonb)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE m public.mentor%ROWTYPE; v_objectives text[]; v_goal text[]; v_shared text[]; v_skills text[]; v_area boolean;
BEGIN
 SELECT * INTO m FROM public.mentor WHERE id = p_mentor;
 v_objectives := CASE p_goal WHEN 'transition' THEN ARRAY['desenvolvimento','design','produto','dados'] WHEN 'growth' THEN ARRAY['produto','dados'] WHEN 'leadership' THEN ARRAY['produto','design'] ELSE ARRAY[]::text[] END;
 v_goal := ARRAY(SELECT s.v FROM jsonb_array_elements_text(m.specialties) WITH ORDINALITY s(v, n) WHERE s.v = ANY (v_objectives) AND p_interests ? s.v ORDER BY s.n);
 v_shared := ARRAY(SELECT s.v FROM jsonb_array_elements_text(m.specialties) WITH ORDINALITY s(v, n) WHERE p_interests ? s.v ORDER BY s.n);
 v_skills := ARRAY(SELECT k.v FROM jsonb_array_elements_text(p_skills) WITH ORDINALITY k(v, n)
  WHERE m.specialties ? (CASE k.v WHEN 'codigo' THEN 'desenvolvimento' WHEN 'analise' THEN 'dados' WHEN 'comunicacao' THEN 'produto' WHEN 'gestao' THEN 'design' END) ORDER BY k.n);
 v_area := coalesce(p_area, '') <> '' AND m.specialties ? p_area;
 o_score := cardinality(v_goal) * 3 + cardinality(v_shared) * 2 + cardinality(v_skills) + CASE WHEN v_area THEN 3 ELSE 0 END;
 o_reasons := to_jsonb(ARRAY(SELECT r FROM unnest(ARRAY[
   CASE WHEN v_area THEN 'Área de atuação em comum: ' || p_area || ' (+3)' END,
   CASE WHEN cardinality(v_goal) > 0 THEN 'Objetivo e especialidades: ' || array_to_string(v_goal, ', ') || ' (+' || cardinality(v_goal) * 3 || ')' END,
   CASE WHEN cardinality(v_shared) > 0 THEN 'Interesses em comum: ' || array_to_string(v_shared, ', ') || ' (+' || cardinality(v_shared) * 2 || ')' END,
   CASE WHEN cardinality(v_skills) > 0 THEN 'Habilidades relacionadas: ' || array_to_string(v_skills, ', ') || ' (+' || cardinality(v_skills) || ')' END
  ]) WITH ORDINALITY x(r, n) WHERE r IS NOT NULL ORDER BY n));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.agenda_ranking(p_participant bigint, p_mentor bigint, OUT o_score integer, OUT o_reasons jsonb)
LANGUAGE plpgsql STABLE SET search_path = pg_catalog, pg_temp AS $$
DECLARE p public.participant%ROWTYPE;
BEGIN
 SELECT * INTO p FROM public.participant WHERE id = p_participant;
 SELECT r.o_score, r.o_reasons INTO o_score, o_reasons FROM internal.agenda_ranking_values(p.goal, p.interests, p.skills, p.area, p_mentor) r;
END $$;
--> statement-breakpoint
-- Mesmas regras de entrada do cadastro anterior (o contrato HTTP já é fechado; o banco recusa o que escapar).
CREATE OR REPLACE FUNCTION internal.registration_profile_check(p_goal text, p_moment text, p_interests jsonb, p_skills jsonb, p_area text) RETURNS void
LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_goal IS NULL OR p_goal NOT IN ('transition','growth','leadership') OR p_moment IS NULL OR p_moment NOT IN ('starting','working','returning')
  OR jsonb_typeof(p_interests) IS DISTINCT FROM 'array' OR jsonb_typeof(p_skills) IS DISTINCT FROM 'array' OR length(coalesce(p_area,'')) NOT BETWEEN 1 AND 100 THEN
  RAISE EXCEPTION 'invalid registration';
 END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.registration_candidates(p_goal text, p_interests jsonb, p_skills jsonb, p_area text)
RETURNS TABLE(mentor_id bigint, score integer, reasons jsonb, label text)
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT s.id, (s.r).o_score, (s.r).o_reasons, s.label FROM (
  SELECT m.id, internal.agenda_ranking_values(p_goal, p_interests, p_skills, p_area, m.id) AS r,
   coalesce(nullif(btrim(m.display_name), ''), '(MENTORA)') AS label
  FROM public.mentor m WHERE m.active AND NOT internal.domain_protected('mentor', m.id)) s
 WHERE (s.r).o_score > 0 ORDER BY (s.r).o_score DESC, s.id;
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.registration_preview(p_goal text, p_moment text, p_interests jsonb, p_skills jsonb, p_area text) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 PERFORM internal.registration_profile_check(p_goal, p_moment, p_interests, p_skills, p_area);
 RETURN coalesce((SELECT jsonb_agg(jsonb_build_object('id', c.mentor_id::text, 'name', c.label) ORDER BY c.score DESC, c.mentor_id)
  FROM internal.registration_candidates(p_goal, p_interests, p_skills, p_area) c), '[]'::jsonb);
END $$;
--> statement-breakpoint
DROP FUNCTION internal.register_participant_account(text,text,text,jsonb,jsonb,text);
--> statement-breakpoint
CREATE FUNCTION internal.register_participant_account(p_email text, p_password_hash text, p_goal text, p_moment text, p_interests jsonb, p_skills jsonb, p_area text, p_mentor bigint) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_email text := btrim(p_email); v_key text := lower(btrim(p_email)); v_user uuid := gen_random_uuid(); v_ins uuid; v_participant bigint; v_match bigint; c record;
BEGIN
 IF v_email IS NULL OR length(v_email) NOT BETWEEN 3 AND 254 OR v_email !~ '^[\x21-\x7e]+@[^@\s]+\.[^@\s]+$' THEN RAISE EXCEPTION 'invalid registration'; END IF;
 IF p_password_hash IS NULL OR p_password_hash !~ '^[a-f0-9]{32}:[a-f0-9]{128}$' THEN RAISE EXCEPTION 'invalid registration'; END IF;
 PERFORM internal.registration_profile_check(p_goal, p_moment, p_interests, p_skills, p_area);
 -- Crossing revalidado sob lock e ANTES do e-mail: o resultado não depende de a conta existir (sem enumeração).
 PERFORM 1 FROM public.mentor m WHERE m.id = p_mentor FOR SHARE;
 SELECT * INTO c FROM internal.registration_candidates(p_goal, p_interests, p_skills, p_area) x WHERE x.mentor_id = p_mentor;
 IF NOT FOUND THEN RAISE EXCEPTION 'registration_mentor_unavailable'; END IF;
 IF EXISTS (SELECT 1 FROM public.participant WHERE user_id IS NULL AND lower(btrim(email)) = v_key)
  OR EXISTS (SELECT 1 FROM public.mentor WHERE user_id IS NULL AND lower(btrim(email)) = v_key)
  OR v_key IN (SELECT k.ekey FROM internal.privileged_email_keys() k) THEN RETURN false; END IF;
 INSERT INTO public.app_user(id, email, status, password_hash) VALUES (v_user, v_email, 'active', p_password_hash)
  ON CONFLICT ON CONSTRAINT app_user_email_key_unique DO NOTHING RETURNING id INTO v_ins;
 IF v_ins IS NULL THEN RETURN false; END IF;
 INSERT INTO public.user_role(user_id, role) VALUES (v_user, 'participant');
 INSERT INTO public.participant(email, goal, moment, interests, skills, area, token_hash, consent_version, consent_at, user_id)
  VALUES (v_email, p_goal, p_moment, p_interests, p_skills, p_area, encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'UTF8')), 'hex'), 'v1', now(), v_user) RETURNING id INTO v_participant;
 INSERT INTO public.match(participant_id, mentor_id, score, reasons, status, origin) VALUES (v_participant, p_mentor, c.score, c.reasons, 'suggested', 'current') RETURNING id INTO v_match;
 INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id)
  VALUES (v_user, 'match.create', 'match', v_match::text, '["participantId","mentorId","status"]'::jsonb, 'ok', gen_random_uuid());
 RETURN true;
END $$;
--> statement-breakpoint
GRANT INSERT (password_hash) ON public.app_user TO techwoman_owner;
REVOKE ALL ON FUNCTION internal.agenda_ranking_values(text,jsonb,jsonb,text,bigint), internal.registration_profile_check(text,text,jsonb,jsonb,text),
 internal.registration_candidates(text,jsonb,jsonb,text), internal.registration_preview(text,text,jsonb,jsonb,text),
 internal.register_participant_account(text,text,text,text,jsonb,jsonb,text,bigint) FROM PUBLIC;
--> statement-breakpoint
-- ALTER OWNER exige CREATE do novo dono no schema: concedido só durante a transferência (mesmo padrão das migrations anteriores).
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.agenda_ranking_values(text,jsonb,jsonb,text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.registration_profile_check(text,text,jsonb,jsonb,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.registration_candidates(text,jsonb,jsonb,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.registration_preview(text,text,jsonb,jsonb,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.register_participant_account(text,text,text,text,jsonb,jsonb,text,bigint) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.registration_preview(text,text,jsonb,jsonb,text), internal.register_participant_account(text,text,text,text,jsonb,jsonb,text,bigint) TO techwoman_runtime;
 END IF;
END $$;
--> statement-breakpoint
-- Falha fechada: nenhuma SECURITY DEFINER da aplicação fora do owner NOLOGIN/search_path fixo; assinatura antiga não sobrevive.
DO $$ DECLARE v text; BEGIN
 SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
  WHERE p.prosecdef AND p.pronamespace IN ('internal'::regnamespace, 'public'::regnamespace)
   AND (o.rolname <> 'techwoman_owner' OR o.rolcanlogin OR o.rolsuper OR o.rolbypassrls
    OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c ~ '^search_path=pg_catalog(, [a-z_]+)*, pg_temp$'));
 IF v IS NOT NULL THEN RAISE EXCEPTION 'SECURITY DEFINER fora do owner NOLOGIN/search_path fixo: %', v; END IF;
 IF to_regprocedure('internal.register_participant_account(text,text,text,jsonb,jsonb,text)') IS NOT NULL THEN RAISE EXCEPTION 'assinatura antiga do cadastro sobreviveu'; END IF;
END $$;
