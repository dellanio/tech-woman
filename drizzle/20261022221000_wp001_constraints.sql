-- Complementos não representáveis pelo gerador; sem seed de domínio.
ALTER TABLE public.mentor_topic ADD CONSTRAINT mentor_topic_position_unique UNIQUE (mentor_id,position) DEFERRABLE INITIALLY IMMEDIATE;
INSERT INTO internal.agenda_guard(id,revision) VALUES(1,0);
CREATE SCHEMA legacy_snapshot;
REVOKE ALL ON SCHEMA legacy_snapshot FROM PUBLIC;
CREATE TABLE legacy_snapshot.source_table (
 run_id uuid NOT NULL REFERENCES public.migration_run(id), name text NOT NULL,
 ddl text, columns jsonb NOT NULL, PRIMARY KEY(run_id,name)
);
CREATE TABLE legacy_snapshot.source_row (
 run_id uuid NOT NULL, table_name text NOT NULL, row_number bigint NOT NULL, cells jsonb NOT NULL,
 PRIMARY KEY(run_id,table_name,row_number),
 FOREIGN KEY(run_id,table_name) REFERENCES legacy_snapshot.source_table(run_id,name)
);
CREATE FUNCTION internal.touch_version() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN NEW.updated_at=clock_timestamp(); NEW.version=OLD.version+1; RETURN NEW; END $$;
REVOKE ALL ON FUNCTION internal.touch_version() FROM PUBLIC;
DO $$ DECLARE t text; BEGIN
 FOREACH t IN ARRAY ARRAY['app_user','participant','mentor','match','topic','mentor_topic','cohort','enrollment','event_content'] LOOP
  EXECUTE format('CREATE TRIGGER touch_version BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION internal.touch_version()',t);
 END LOOP;
END $$;
CREATE INDEX participant_user_idx ON participant(user_id);
CREATE INDEX mentor_user_idx ON mentor(user_id);
CREATE INDEX match_participant_idx ON match(participant_id);
CREATE INDEX match_mentor_idx ON match(mentor_id);
CREATE INDEX mentor_topic_topic_idx ON mentor_topic(topic_id);
CREATE INDEX cohort_mentor_start_idx ON cohort(mentor_topic_id,starts_at);
CREATE INDEX cohort_status_start_idx ON cohort(status,starts_at);
CREATE INDEX enrollment_cohort_status_idx ON enrollment(cohort_id,status);
CREATE INDEX enrollment_participant_status_idx ON enrollment(participant_id,status);
CREATE INDEX auth_session_user_expiry_idx ON auth_session(user_id,expires_at);
CREATE INDEX password_reset_user_idx ON password_reset_token(user_id,expires_at);
CREATE INDEX email_job_user_idx ON email_job(user_id);
CREATE INDEX email_job_queue_idx ON email_job(status,next_attempt_at);
CREATE INDEX email_delivery_job_idx ON email_delivery_attempt(job_id);
CREATE INDEX migration_link_user_idx ON migration_identity_link(user_id);
