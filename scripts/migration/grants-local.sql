-- Compatibilidade local INT-002. Política de domínio/RLS final: WP-003/OPS.
-- Executado DEPOIS das migrations. Não desfazer USAGE/EXECUTE mínimo concedido por elas.
GRANT USAGE ON SCHEMA public,internal TO techwoman_runtime,techwoman_mailer;
-- Home/evento: só leitura do conteúdo público. Domínio (participant/mentor/match/tentativas legadas/agenda) passa exclusivamente pelas operações
-- SQL do owner (WP-003); este script nunca reabre DML/SELECT de domínio nem sequences ao runtime.
GRANT SELECT ON event_content,demo_seed_state TO techwoman_runtime;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON event_content,demo_seed_state FROM techwoman_runtime;
REVOKE ALL ON participant,mentor,match,email_attempt,choice_email_attempt,topic,mentor_topic,cohort,enrollment,participant_editor,mentor_editor FROM techwoman_runtime,techwoman_mailer;
REVOKE ALL ON SEQUENCE participant_id_seq,mentor_id_seq,match_id_seq FROM techwoman_runtime,techwoman_mailer;
-- Identidade e fila passam exclusivamente por funções fechadas; nunca SELECT integral de hashes.
REVOKE ALL ON app_user,user_role,auth_session,password_reset_token,email_job,email_delivery_attempt FROM techwoman_runtime,techwoman_mailer;
REVOKE ALL ON SCHEMA legacy_snapshot FROM techwoman_runtime,techwoman_mailer;
REVOKE ALL ON migration_run,migration_identity_link,migration_issue,internal.schema_migration,internal.agenda_guard FROM techwoman_runtime,techwoman_mailer;
