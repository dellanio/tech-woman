-- Arquivo privado também mantém referências restritivas.
ALTER TABLE legacy_snapshot.source_row DROP CONSTRAINT source_row_run_id_table_name_fkey;
ALTER TABLE legacy_snapshot.source_row ADD CONSTRAINT source_row_run_id_table_name_fkey FOREIGN KEY(run_id,table_name) REFERENCES legacy_snapshot.source_table(run_id,name) ON DELETE RESTRICT;
ALTER TABLE legacy_snapshot.source_table DROP CONSTRAINT source_table_run_id_fkey;
ALTER TABLE legacy_snapshot.source_table ADD CONSTRAINT source_table_run_id_fkey FOREIGN KEY(run_id) REFERENCES public.migration_run(id) ON DELETE RESTRICT;
CREATE INDEX audit_event_actor_idx ON audit_event(actor_user_id);
CREATE INDEX migration_issue_run_idx ON migration_issue(run_id);
CREATE INDEX email_job_participant_idx ON email_job(participant_id);
CREATE INDEX email_job_enrollment_idx ON email_job(enrollment_id);
CREATE INDEX choice_email_mentor_idx ON choice_email_attempt(mentor_id);
ALTER TABLE audit_event ADD CONSTRAINT audit_fields_array CHECK(jsonb_typeof(changed_fields)='array');
