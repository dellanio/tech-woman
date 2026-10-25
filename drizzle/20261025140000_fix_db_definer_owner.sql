-- FIX-DB T2 (D-038, G3-03/T12): as 41 SECURITY DEFINER WP-002 de identidade/fila/limites passam da migradora (LOGIN) para
-- techwoman_owner (NOLOGIN, sem BYPASSRLS/privilégios de cluster); a exceção da matriz deixa de existir. Assinaturas, corpos,
-- search_path e EXECUTE de runtime/mailer/editora/PUBLIC não mudam (ALTER OWNER reescreve o grantor na ACL, não os grantees).
-- O owner recebe só o que essas funções executam: SELECT nas tabelas que leem (linha inteira de app_user/auth_session via %ROWTYPE),
-- INSERT/UPDATE por coluna nas colunas que escrevem e DELETE só onde a função apaga. Nunca TRUNCATE/REFERENCES/TRIGGER, DDL ou grant option;
-- nenhuma concessão nova a runtime/mailer/editora. RLS: participant/mentor já têm as policies agenda_api_owner_* do owner (WP-003).
GRANT SELECT, UPDATE (email, password_hash, temporary_password_hash, temporary_expires_at, temporary_used_at, credential_generation, must_change_password, status, session_version, updated_at, version),
 INSERT (id, email, status) ON public.app_user TO techwoman_owner;
GRANT SELECT, INSERT (user_id, role), DELETE ON public.user_role TO techwoman_owner;
GRANT SELECT, INSERT (id, user_id, token_hash, scope, session_version, expires_at), UPDATE (revoked_at) ON public.auth_session TO techwoman_owner;
GRANT SELECT, INSERT (id, user_id, token_hash, generation, expires_at), UPDATE (used_at, revoked_at) ON public.password_reset_token TO techwoman_owner;
GRANT SELECT, UPDATE (status, attempts, generation, lease_owner, lease_until, next_attempt_at, updated_at) ON public.email_job TO techwoman_owner;
GRANT SELECT, INSERT (id, job_id, generation, status), UPDATE (status, provider_id, error_code, completed_at) ON public.email_delivery_attempt TO techwoman_owner;
GRANT SELECT, INSERT (id, actor_key, method, path, key_hash, request_hash, expires_at), UPDATE (status_code, resource_id), DELETE ON public.api_idempotency TO techwoman_owner;
GRANT SELECT, INSERT (bucket_key, window_start, count, expires_at), UPDATE (window_start, count, expires_at), DELETE ON public.auth_rate_bucket TO techwoman_owner;
GRANT SELECT, UPDATE (resolution) ON public.migration_identity_link TO techwoman_owner;
GRANT SELECT ON public.migration_issue TO techwoman_owner;
-- activate_legacy_identity liga perfis do mapa à conta (user_id) e revoga o token legado.
GRANT UPDATE (user_id, legacy_access_revoked_at) ON public.participant TO techwoman_owner;
GRANT UPDATE (user_id) ON public.mentor TO techwoman_owner;
--> statement-breakpoint
-- ALTER OWNER exige CREATE do novo dono no schema: concedido só durante a transferência (mesmo padrão do WP-003).
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.cancel_identity_jobs(uuid,text[],text[]) OWNER TO techwoman_owner;
ALTER FUNCTION internal.identity_login_begin(text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.identity_login_finish(uuid,text,bigint,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.identity_session_get(text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.identity_change_begin(text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.identity_change_finish(text,bigint,text,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.identity_logout(text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.issue_temporary_credential(uuid,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.issue_reset_token(uuid,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.consume_reset_token(text,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.register_participant_account(text,text,text,jsonb,jsonb,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.register_mentor_account(text,text,text,jsonb,text,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.activate_legacy_identity(uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.request_password_forgot(text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.enqueue_admin_temporary(uuid,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.add_own_participant_profile(text,text,text,jsonb,jsonb,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.add_own_mentor_profile(text,text,text,jsonb,text,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.email_claim(uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.email_emit_begin(uuid,uuid,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.email_emit_finish(uuid,uuid,uuid,text,text,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.migration_flagged_keys(boolean) OWNER TO techwoman_owner;
ALTER FUNCTION internal.privileged_email_keys() OWNER TO techwoman_owner;
ALTER FUNCTION internal.collision_unresolved(text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.user_protected(uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.domain_protected(text,bigint) OWNER TO techwoman_owner;
ALTER FUNCTION internal.admin_actor(text,boolean,uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.account_result(text,uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.user_has_active_enrollment(uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.role_has_active_enrollment(uuid,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.email_destination_taken(text,uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.idem_begin(text,text,text,text,text) OWNER TO techwoman_owner;
ALTER FUNCTION internal.idem_finish(uuid,text,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.idem_abort(uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.admin_user_list(text,uuid,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.admin_user_get(text,uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.admin_user_update(text,uuid,bigint,jsonb,uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.admin_user_disable(text,uuid,bigint,uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.admin_user_resend(text,uuid,uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.admin_user_create(text,uuid,text,text,text[],jsonb,jsonb,uuid) OWNER TO techwoman_owner;
ALTER FUNCTION internal.rate_hit(text,integer,integer) OWNER TO techwoman_owner;
ALTER FUNCTION internal.lock_domain_owner(text,bigint) OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
-- Falha fechada (fresh e upgrade): nenhuma SECURITY DEFINER da aplicação fica com dono LOGIN/diferente do owner ou sem search_path fixo.
DO $$ DECLARE v text; BEGIN
 SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text) INTO v FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_roles o ON o.oid = p.proowner
  WHERE p.prosecdef AND p.pronamespace IN ('internal'::regnamespace, 'public'::regnamespace)
   AND (o.rolname <> 'techwoman_owner' OR o.rolcanlogin OR o.rolsuper OR o.rolbypassrls
    OR NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) c WHERE c ~ '^search_path=pg_catalog(, [a-z_]+)*, pg_temp$'));
 IF v IS NOT NULL THEN RAISE EXCEPTION 'SECURITY DEFINER fora do owner NOLOGIN/search_path fixo: %', v; END IF;
END $$;
