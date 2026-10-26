-- WP-003 correção final I4: helpers privilegiados de identidade criados/redefinidos no WP-003 passam ao owner NOLOGIN (techwoman_owner),
-- sem role extra. O owner recebe só as colunas que essas funções leem/escrevem; nenhuma concessão nova ao runtime/mailer/editora.
-- Funções WP-002 herdadas continuam com o dono da migração (registro para o OPS na matriz); a que chama lock_users recebe EXECUTE explícito.
-- api_session_actor: sessão (colunas de validade) + ator (status/versão/troca pendente) + papéis.
GRANT SELECT (user_id, token_hash, revoked_at, expires_at, scope, session_version) ON public.auth_session TO techwoman_owner;
GRANT SELECT (id, email_key, status, session_version, must_change_password) ON public.app_user TO techwoman_owner;
GRANT SELECT (user_id, role) ON public.user_role TO techwoman_owner;
-- lock_user_set: FOR NO KEY UPDATE exige UPDATE em ao menos uma coluna; updated_at é a única concedida (nenhuma função do owner a escreve).
GRANT UPDATE (updated_at) ON public.app_user TO techwoman_owner;
-- api_account_create: conta pendente + papel participant/mentor (validado na função), destino indisponível pelo predicado WP-002.
GRANT INSERT (id, email, status) ON public.app_user TO techwoman_owner;
GRANT INSERT (user_id, role) ON public.user_role TO techwoman_owner;
GRANT EXECUTE ON FUNCTION internal.email_destination_taken(text,uuid) TO techwoman_owner;
--> statement-breakpoint
-- Definer legítimo WP-002 (admin_actor → lock_users) continua executando depois da troca de dono.
DO $$ BEGIN
 EXECUTE format('GRANT EXECUTE ON FUNCTION internal.lock_users(uuid,uuid) TO %I',
  (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p WHERE p.oid = 'internal.admin_actor(text,boolean,uuid)'::regprocedure));
END $$;
--> statement-breakpoint
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.lock_user_set(uuid[]) OWNER TO techwoman_owner;
ALTER FUNCTION internal.lock_users(uuid,uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_session_actor(text,uuid[]) OWNER TO techwoman_owner;
ALTER FUNCTION internal.api_account_create(text,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.domain_lock_users(text,bigint[]) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.lock_user_set(uuid[]), internal.lock_users(uuid,uuid), internal.api_session_actor(text,uuid[]), internal.api_account_create(text,text),
 internal.domain_lock_users(text,bigint[]) FROM PUBLIC;
