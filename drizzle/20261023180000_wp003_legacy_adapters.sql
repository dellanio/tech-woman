-- WP-003 Task 5: adaptadores antigos (CONTRATOS §7) como operações SQL autorizadas, no mesmo desenho das operações v1.
-- Cada chamada: autentica o digest da sessão, trava ator + contas que protegem as linhas citadas (FOR NO KEY UPDATE, ordem de UUID) -> guard
-- -> releitura das contas (mudou = 40001, retry integral) -> proteção/existência (404) ANTES de qualquer ação -> ação permitida + auditoria com ator.
-- Nenhum caminho antigo aprova par, reserva por capacidade da mentora ou cria match por token; aprovação/realocação sem turma = 422 (fluxo v1).

-- Identidade (função da migradora, como as de WP-002): contas que decidem a proteção das linhas de domínio citadas — dona vinculada e contas
-- com a mesma chave de e-mail (domain_protected também protege por e-mail de admin/team). Só o owner executa; devolve apenas UUIDs.
CREATE OR REPLACE FUNCTION internal.domain_lock_users(p_table text, p_ids bigint[]) RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
BEGIN
 IF p_table = 'participant' THEN
  RETURN ARRAY(SELECT DISTINCT a.id FROM public.participant d JOIN public.app_user a ON a.id = d.user_id OR a.email_key = lower(btrim(d.email)) WHERE d.id = ANY (p_ids) ORDER BY a.id);
 ELSIF p_table = 'mentor' THEN
  RETURN ARRAY(SELECT DISTINCT a.id FROM public.mentor d JOIN public.app_user a ON a.id = d.user_id OR a.email_key = lower(btrim(d.email)) WHERE d.id = ANY (p_ids) ORDER BY a.id);
 END IF;
 RETURN ARRAY[]::uuid[];
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.domain_lock_users(text,bigint[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION internal.domain_lock_users(text,bigint[]) TO techwoman_owner;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_legacy_owners(p_participants bigint[], p_mentors bigint[]) RETURNS uuid[]
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT ARRAY(SELECT DISTINCT u FROM unnest(internal.domain_lock_users('participant', p_participants) || internal.domain_lock_users('mentor', p_mentors)) u ORDER BY u);
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.api_legacy_visible(p_kind text, p_id bigint) RETURNS boolean
LANGUAGE sql STABLE SET search_path = pg_catalog, pg_temp AS $$
 SELECT p_id IS NOT NULL AND internal.api_domain_exists(p_kind, p_id) AND NOT internal.domain_protected(p_kind, p_id);
$$;
--> statement-breakpoint
-- Início de toda escrita antiga: ator admin revalidado sob lock (junto das contas das linhas citadas), depois o guard.
CREATE OR REPLACE FUNCTION internal.api_legacy_begin(p_digest text, p_request uuid, p_participants bigint[], p_mentors bigint[]) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; v_owners uuid[];
BEGIN
 v_owners := internal.api_legacy_owners(p_participants, p_mentors);
 SELECT * INTO a FROM internal.api_auth(p_digest, v_owners, p_request);
 IF NOT ('admin' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 PERFORM internal.api_guard();
 IF internal.api_legacy_owners(p_participants, p_mentors) IS DISTINCT FROM v_owners THEN RAISE EXCEPTION 'domain owner changed' USING ERRCODE = '40001'; END IF;
 RETURN a.o_actor;
END $$;
--> statement-breakpoint
-- GET /api/admin/overview: leitura admin/team; participantes/mentoras protegidos fora, inclusive das sugestões e do par legado exibido.
CREATE OR REPLACE FUNCTION internal.api_legacy_overview(p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record;
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, NULL, NULL);
 IF NOT (a.o_roles && ARRAY['admin','team']) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 RETURN (WITH vm AS (
   SELECT m.id, m.demo, m.active, m.capacity, m.trajectory, m.specialties, m.availability,
    CASE WHEN m.demo THEN coalesce(nullif(btrim(m.demo_name), ''), 'Mentora fictícia') ELSE m.email END AS label,
    (SELECT count(*)::int FROM public.match x WHERE x.mentor_id = m.id AND x.origin = 'legacy' AND x.status = 'approved') AS occupied
   FROM public.mentor m WHERE NOT internal.domain_protected('mentor', m.id)),
  vp AS (SELECT p.id, p.email, p.area, p.goal, p.moment, p.interests FROM public.participant p WHERE NOT internal.domain_protected('participant', p.id))
  SELECT jsonb_build_object(
   'participants', coalesce((SELECT jsonb_agg(jsonb_build_object('id', p.id::text, 'protocol', 'TW-' || lpad(p.id::text, 5, '0'), 'email', p.email, 'area', p.area,
     'goal', p.goal, 'moment', p.moment, 'interests', p.interests,
     'approvedMentorId', (SELECT x.mentor_id::text FROM public.match x JOIN vm ON vm.id = x.mentor_id WHERE x.participant_id = p.id AND x.origin = 'legacy' AND x.status = 'approved' ORDER BY x.id LIMIT 1),
     'choices', coalesce((SELECT jsonb_agg(jsonb_build_object('mentorId', c.id::text, 'mentorEmail', c.label, 'demo', c.demo, 'capacity', c.capacity, 'occupied', c.occupied,
        'score', (c.r).o_score, 'reasons', (c.r).o_reasons) ORDER BY (c.r).o_score DESC, c.id)
       FROM (SELECT vm.*, internal.agenda_ranking(p.id, vm.id) AS r FROM vm WHERE vm.active
        AND NOT EXISTS (SELECT 1 FROM public.match x WHERE x.participant_id = p.id AND x.mentor_id = vm.id AND x.status = 'rejected')) c WHERE (c.r).o_score > 0), '[]'::jsonb))
    ORDER BY p.id) FROM vp p), '[]'::jsonb),
   'mentors', coalesce((SELECT jsonb_agg(jsonb_build_object('id', m.id::text, 'email', m.label, 'demo', m.demo, 'trajectory', m.trajectory, 'specialties', m.specialties,
     'availability', m.availability, 'capacity', m.capacity, 'occupied', m.occupied, 'active', m.active) ORDER BY m.id) FROM vm m), '[]'::jsonb)));
END $$;
--> statement-breakpoint
-- POST /api/admin/decide {participantId,mentorId,action}: approve nunca aprova (422 cohortId, depois do 404 de protegido/inexistente);
-- reject só rejeita sugestão current sem reserva (ou registra a rejeição da sugestão calculada quando o par não tem match). Score do servidor.
CREATE OR REPLACE FUNCTION internal.api_legacy_decide(p_digest text, p_request uuid, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_actor uuid; v_participant bigint; v_mentor bigint; v_action text; x public.match%ROWTYPE; r record;
BEGIN
 PERFORM internal.api_patch_keys(p_body, ARRAY['participantId','mentorId','action']);
 v_participant := internal.api_sql_id(p_body -> 'participantId', 'participantId');
 v_mentor := internal.api_sql_id(p_body -> 'mentorId', 'mentorId');
 v_action := p_body ->> 'action';
 IF jsonb_typeof(p_body -> 'action') IS DISTINCT FROM 'string' OR v_action NOT IN ('approve','reject') THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['action']); END IF;
 v_actor := internal.api_legacy_begin(p_digest, p_request, ARRAY[v_participant], ARRAY[v_mentor]);
 IF NOT internal.api_legacy_visible('participant', v_participant) OR NOT internal.api_legacy_visible('mentor', v_mentor) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
 PERFORM 1 FROM public.participant p WHERE p.id = v_participant FOR NO KEY UPDATE;
 PERFORM 1 FROM public.mentor m WHERE m.id = v_mentor FOR NO KEY UPDATE;
 IF v_action = 'approve' THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['cohortId']); END IF;
 SELECT * INTO x FROM public.match m WHERE m.participant_id = v_participant AND m.mentor_id = v_mentor AND m.origin = 'current' AND m.status = 'suggested' AND m.enrollment_id IS NULL
  ORDER BY m.id LIMIT 1 FOR NO KEY UPDATE;
 IF FOUND THEN
  UPDATE public.match m SET status = 'rejected' WHERE m.id = x.id;
 ELSIF EXISTS (SELECT 1 FROM public.match m WHERE m.participant_id = v_participant AND m.mentor_id = v_mentor) THEN
  PERFORM internal.api_fail('INVALID_INPUT', ARRAY['status']);
 ELSE
  SELECT * INTO r FROM internal.agenda_ranking(v_participant, v_mentor);
  INSERT INTO public.match(participant_id, mentor_id, score, reasons, status, origin) VALUES (v_participant, v_mentor, r.o_score, r.o_reasons, 'rejected', 'current') RETURNING * INTO x;
 END IF;
 PERFORM internal.api_audit(v_actor, 'match.reject', 'match', x.id::text, '["status"]'::jsonb, p_request);
 RETURN jsonb_build_object('status', 'Sugestão rejeitada');
END $$;
--> statement-breakpoint
-- POST /api/admin/change: cancel (par legado aprovado → cancelled, histórico preservado), reassign (sempre 422 cohortId depois do 404),
-- activate/deactivate (soft; reserva ativa → validador recusa) e remove-demo (todas as demo ativas não protegidas num só statement: sem parcial).
CREATE OR REPLACE FUNCTION internal.api_legacy_change(p_digest text, p_request uuid, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_action text; v_actor uuid; v_participant bigint; v_mentor bigint; v_seen bigint; v_match bigint; v_active boolean; v_ids bigint[]; v_id bigint;
BEGIN
 IF p_body IS NULL OR jsonb_typeof(p_body) <> 'object' THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['body']); END IF;
 v_action := p_body ->> 'action';
 IF jsonb_typeof(p_body -> 'action') IS DISTINCT FROM 'string' OR v_action NOT IN ('cancel','reassign','activate','deactivate','remove-demo') THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['action']); END IF;
 IF v_action = 'cancel' THEN
  PERFORM internal.api_patch_keys(p_body, ARRAY['action','participantId']);
  v_participant := internal.api_sql_id(p_body -> 'participantId', 'participantId');
  -- lido antes do lock só para incluir a conta da mentora no conjunto travado; relido sob lock depois do guard
  v_mentor := (SELECT x.mentor_id FROM public.match x WHERE x.participant_id = v_participant AND x.origin = 'legacy' AND x.status = 'approved' ORDER BY x.id LIMIT 1);
  v_actor := internal.api_legacy_begin(p_digest, p_request, ARRAY[v_participant], ARRAY(SELECT v FROM unnest(ARRAY[v_mentor]) v WHERE v IS NOT NULL));
  IF NOT internal.api_legacy_visible('participant', v_participant) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
  PERFORM 1 FROM public.participant p WHERE p.id = v_participant FOR NO KEY UPDATE;
  SELECT x.id, x.mentor_id INTO v_match, v_seen FROM public.match x WHERE x.participant_id = v_participant AND x.origin = 'legacy' AND x.status = 'approved' ORDER BY x.id LIMIT 1 FOR NO KEY UPDATE;
  IF v_seen IS DISTINCT FROM v_mentor THEN RAISE EXCEPTION 'legacy pair changed' USING ERRCODE = '40001'; END IF;
  IF v_match IS NULL THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['participantId']); END IF;
  IF NOT internal.api_legacy_visible('mentor', v_mentor) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
  UPDATE public.match x SET status = 'cancelled' WHERE x.id = v_match;
  PERFORM internal.api_audit(v_actor, 'match.cancel', 'match', v_match::text, '["status"]'::jsonb, p_request);
  RETURN jsonb_build_object('status', 'Reserva cancelada');
 ELSIF v_action = 'reassign' THEN
  PERFORM internal.api_patch_keys(p_body, ARRAY['action','participantId','mentorId']);
  v_participant := internal.api_sql_id(p_body -> 'participantId', 'participantId');
  IF p_body ? 'mentorId' THEN v_mentor := internal.api_sql_id(p_body -> 'mentorId', 'mentorId'); END IF;
  v_actor := internal.api_legacy_begin(p_digest, p_request, ARRAY[v_participant], ARRAY(SELECT v FROM unnest(ARRAY[v_mentor]) v WHERE v IS NOT NULL));
  IF NOT internal.api_legacy_visible('participant', v_participant) OR (v_mentor IS NOT NULL AND NOT internal.api_legacy_visible('mentor', v_mentor)) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
  PERFORM internal.api_fail('INVALID_INPUT', ARRAY['cohortId']);
 ELSIF v_action IN ('activate','deactivate') THEN
  PERFORM internal.api_patch_keys(p_body, ARRAY['action','mentorId']);
  v_mentor := internal.api_sql_id(p_body -> 'mentorId', 'mentorId');
  v_actor := internal.api_legacy_begin(p_digest, p_request, ARRAY[]::bigint[], ARRAY[v_mentor]);
  IF NOT internal.api_legacy_visible('mentor', v_mentor) THEN PERFORM internal.api_fail('NOT_FOUND'); END IF;
  SELECT m.active INTO v_active FROM public.mentor m WHERE m.id = v_mentor FOR NO KEY UPDATE;
  IF v_active IS DISTINCT FROM (v_action = 'activate') THEN
   UPDATE public.mentor m SET active = (v_action = 'activate') WHERE m.id = v_mentor;
   PERFORM internal.api_audit(v_actor, 'mentor.' || v_action, 'mentor', v_mentor::text, '["active"]'::jsonb, p_request);
  END IF;
  RETURN jsonb_build_object('status', CASE WHEN v_action = 'activate' THEN 'Mentora ativada' ELSE 'Mentora desativada' END);
 END IF;
 PERFORM internal.api_patch_keys(p_body, ARRAY['action']);
 v_ids := ARRAY(SELECT m.id FROM public.mentor m WHERE m.demo AND m.active ORDER BY m.id);
 v_actor := internal.api_legacy_begin(p_digest, p_request, ARRAY[]::bigint[], v_ids);
 IF ARRAY(SELECT m.id FROM public.mentor m WHERE m.demo AND m.active ORDER BY m.id) IS DISTINCT FROM v_ids THEN RAISE EXCEPTION 'demo set changed' USING ERRCODE = '40001'; END IF;
 v_ids := ARRAY(SELECT v FROM unnest(v_ids) v WHERE NOT internal.domain_protected('mentor', v) ORDER BY v);
 PERFORM 1 FROM public.mentor m WHERE m.id = ANY (v_ids) ORDER BY m.id FOR NO KEY UPDATE;
 UPDATE public.mentor m SET active = false WHERE m.id = ANY (v_ids);
 FOREACH v_id IN ARRAY v_ids LOOP PERFORM internal.api_audit(v_actor, 'mentor.remove_demo', 'mentor', v_id::text, '["active"]'::jsonb, p_request); END LOOP;
 RETURN jsonb_build_object('status', cardinality(v_ids) || ' mentoras de demonstração desativadas.');
END $$;
--> statement-breakpoint
-- PUT /api/admin/event: só admin (ator revalidado sob lock); DTO fechado dos seis textos (≤1500, data civil AAAA-MM-DD ou vazia). Não é Agenda.
CREATE OR REPLACE FUNCTION internal.api_legacy_event_save(p_digest text, p_request uuid, p_body jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE a record; k text; v_date text; v_day date; e public.event_content%ROWTYPE; v_fields text[] := ARRAY[]::text[];
 v_keys constant text[] := ARRAY['description','venue','agenda','speakers','date','duration'];
BEGIN
 SELECT * INTO a FROM internal.api_auth(p_digest, ARRAY[]::uuid[], p_request);
 IF NOT ('admin' = ANY (a.o_roles)) THEN PERFORM internal.api_fail('FORBIDDEN'); END IF;
 PERFORM internal.api_patch_keys(p_body, v_keys);
 FOREACH k IN ARRAY v_keys LOOP
  IF jsonb_typeof(p_body -> k) IS DISTINCT FROM 'string' OR length(btrim(p_body ->> k)) > 1500 THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY[k]); END IF;
 END LOOP;
 v_date := btrim(p_body ->> 'date');
 IF v_date <> '' THEN
  IF v_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['date']); END IF;
  BEGIN v_day := v_date::date; EXCEPTION WHEN others THEN v_day := NULL; END;
  IF v_day IS NULL OR to_char(v_day, 'YYYY-MM-DD') <> v_date THEN PERFORM internal.api_fail('INVALID_INPUT', ARRAY['date']); END IF;
 END IF;
 SELECT * INTO e FROM public.event_content x WHERE x.id = 1 FOR NO KEY UPDATE;
 FOREACH k IN ARRAY v_keys LOOP
  IF NOT FOUND OR (to_jsonb(e) ->> k) IS DISTINCT FROM btrim(p_body ->> k) THEN v_fields := array_append(v_fields, k); END IF;
 END LOOP;
 INSERT INTO public.event_content AS x (id, description, venue, agenda, speakers, date, duration)
  VALUES (1, btrim(p_body ->> 'description'), btrim(p_body ->> 'venue'), btrim(p_body ->> 'agenda'), btrim(p_body ->> 'speakers'), v_date, btrim(p_body ->> 'duration'))
  ON CONFLICT (id) DO UPDATE SET description = EXCLUDED.description, venue = EXCLUDED.venue, agenda = EXCLUDED.agenda, speakers = EXCLUDED.speakers, date = EXCLUDED.date, duration = EXCLUDED.duration
  RETURNING * INTO e;
 IF cardinality(v_fields) > 0 THEN PERFORM internal.api_audit(a.o_actor, 'event.update', 'event_content', '1', to_jsonb(v_fields), p_request); END IF;
 RETURN jsonb_build_object('description', e.description, 'venue', e.venue, 'agenda', e.agenda, 'speakers', e.speakers, 'date', e.date, 'duration', e.duration);
END $$;
--> statement-breakpoint
-- Link antigo por token (GET /api/state, /api/choice, página de estado): busca SÓ pelo hash; participante não vinculada, não protegida e com acesso
-- não revogado (ativada/revogada/admin/candidato → NULL = 404). Histórico legado sem turma inventada; mentora só pela projeção pública (sem e-mail/conta).
CREATE OR REPLACE FUNCTION internal.api_legacy_state(p_digest text) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE p public.participant%ROWTYPE; x record;
BEGIN
 IF p_digest IS NULL OR p_digest !~ '^[a-f0-9]{64}$' THEN RETURN NULL; END IF;
 SELECT * INTO p FROM public.participant d WHERE d.token_hash = p_digest AND d.legacy_access_revoked_at IS NULL AND d.user_id IS NULL;
 IF NOT FOUND OR internal.domain_protected('participant', p.id) THEN RETURN NULL; END IF;
 SELECT internal.api_mentor_choice_json(m) ->> 'displayName' AS label, m.demo, m.trajectory, mt.reasons INTO x
  FROM public.match mt JOIN public.mentor m ON m.id = mt.mentor_id WHERE mt.participant_id = p.id AND mt.origin = 'legacy' AND mt.status = 'approved' ORDER BY mt.id LIMIT 1;
 RETURN jsonb_build_object('protocol', 'TW-' || lpad(p.id::text, 5, '0'), 'email', p.email,
  'status', CASE WHEN x.label IS NULL THEN 'Aguardando escolha ou revisão da equipe' ELSE 'Mentoria reservada' END,
  'emailStatus', coalesce((SELECT a.status FROM public.email_attempt a WHERE a.participant_id = p.id), 'unavailable-not-sent'),
  'choiceEmailStatus', CASE WHEN x.label IS NOT NULL THEN (SELECT c.status FROM public.choice_email_attempt c WHERE c.participant_id = p.id) END,
  'mentor', CASE WHEN x.label IS NOT NULL THEN jsonb_build_object('email', x.label, 'displayName', x.label, 'demo', x.demo, 'trajectory', x.trajectory, 'reasons', x.reasons) END);
END $$;
--> statement-breakpoint
GRANT SELECT, INSERT (id, description, venue, agenda, speakers, date, duration), UPDATE (description, venue, agenda, speakers, date, duration) ON public.event_content TO techwoman_owner;
GRANT SELECT ON public.email_attempt, public.choice_email_attempt TO techwoman_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.api_legacy_owners(bigint[],bigint[]), internal.api_legacy_visible(text,bigint), internal.api_legacy_begin(text,uuid,bigint[],bigint[]),
 internal.api_legacy_overview(text), internal.api_legacy_decide(text,uuid,jsonb), internal.api_legacy_change(text,uuid,jsonb), internal.api_legacy_event_save(text,uuid,jsonb), internal.api_legacy_state(text) FROM PUBLIC;
--> statement-breakpoint
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.api_legacy_owners(bigint[],bigint[]) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_legacy_visible(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_legacy_begin(text,uuid,bigint[],bigint[]) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_legacy_overview(text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_legacy_decide(text,uuid,jsonb) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_legacy_change(text,uuid,jsonb) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_legacy_event_save(text,uuid,jsonb) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_legacy_state(text) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.api_legacy_overview(text), internal.api_legacy_decide(text,uuid,jsonb), internal.api_legacy_change(text,uuid,jsonb),
   internal.api_legacy_event_save(text,uuid,jsonb), internal.api_legacy_state(text) TO techwoman_runtime;
 END IF;
END $$;
