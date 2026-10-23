-- Grants de compatibilidade local WP-001. NÃO são a política final WP-002/003/OPS.
GRANT USAGE ON SCHEMA public TO techwoman_runtime, techwoman_mailer;
GRANT SELECT,INSERT,UPDATE ON participant,mentor,match,email_attempt,choice_email_attempt,event_content TO techwoman_runtime;
GRANT SELECT ON app_user,user_role,demo_seed_state TO techwoman_runtime;
GRANT USAGE ON SEQUENCE participant_id_seq,mentor_id_seq,match_id_seq TO techwoman_runtime;
GRANT SELECT,UPDATE ON email_job TO techwoman_mailer;
GRANT INSERT,UPDATE,SELECT ON email_delivery_attempt TO techwoman_mailer;
REVOKE ALL ON SCHEMA internal,legacy_snapshot FROM techwoman_runtime,techwoman_mailer;
REVOKE ALL ON migration_run,migration_identity_link,migration_issue FROM techwoman_runtime,techwoman_mailer;
