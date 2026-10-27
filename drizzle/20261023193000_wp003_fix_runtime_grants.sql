-- WP-003 correção final I3/M4: o runtime não tem mais DML/SELECT livre de domínio. Toda leitura/escrita de participant/mentor/match/agenda passa
-- pelas operações SECURITY DEFINER do owner (internal.api_*), que autenticam o digest, travam contas e aplicam R3. Sem policy RLS do runtime:
-- mesmo uma concessão indevida futura enxerga zero linhas (fail-closed). Fica só a leitura do conteúdo público da home (event_content e
-- demo_seed_state, concedida pelo OPS/grants-local). Exports históricos de email.ts (confirmChoice/confirmRegistration) não têm chamador e
-- deixam de funcionar como runtime: não há compatibilidade alegada para eles.
-- M4: helpers nus da WP-002 sem uso pelo serviço (lock_domain_owner trava app_user FOR SHARE por ID arbitrário) saem do runtime; as funções
-- definer que os usam (operações do owner e funções WP-002) continuam executando com o privilégio dos seus donos.
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['topic','mentor_topic','cohort','enrollment','mentor','participant'] LOOP
  EXECUTE format('DROP POLICY IF EXISTS agenda_runtime ON public.%I', t);
 END LOOP;
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_runtime') THEN
  REVOKE ALL ON public.participant, public.mentor, public.match, public.email_attempt, public.choice_email_attempt, public.topic, public.mentor_topic, public.cohort,
   public.enrollment, public.participant_editor, public.mentor_editor FROM techwoman_runtime;
  REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON public.event_content, public.demo_seed_state FROM techwoman_runtime;
  REVOKE ALL ON SEQUENCE public.participant_id_seq, public.mentor_id_seq, public.match_id_seq FROM techwoman_runtime;
  REVOKE EXECUTE ON FUNCTION internal.lock_domain_owner(text,bigint), internal.domain_protected(text,bigint), internal.user_protected(uuid) FROM techwoman_runtime;
 END IF;
END $$;
