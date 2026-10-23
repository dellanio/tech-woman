-- Compatibilidade local INT-002. Política de domínio/RLS final: WP-003/OPS.
-- Executado DEPOIS das migrations. Não desfazer USAGE/EXECUTE mínimo concedido por elas.
GRANT USAGE ON SCHEMA public,internal TO techwoman_runtime,techwoman_mailer;
GRANT SELECT,INSERT,UPDATE ON participant,mentor,match,email_attempt,choice_email_attempt,event_content TO techwoman_runtime;
GRANT SELECT ON demo_seed_state TO techwoman_runtime;
GRANT USAGE ON SEQUENCE participant_id_seq,mentor_id_seq,match_id_seq TO techwoman_runtime;
-- Identidade e fila passam exclusivamente por funções fechadas; nunca SELECT integral de hashes.
REVOKE ALL ON app_user,user_role,auth_session,password_reset_token,email_job,email_delivery_attempt FROM techwoman_runtime,techwoman_mailer;
REVOKE ALL ON SCHEMA legacy_snapshot FROM techwoman_runtime,techwoman_mailer;
REVOKE ALL ON migration_run,migration_identity_link,migration_issue,internal.schema_migration,internal.agenda_guard FROM techwoman_runtime,techwoman_mailer;
