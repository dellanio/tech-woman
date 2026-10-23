ALTER TABLE "audit_event" DROP CONSTRAINT "audit_event_actor_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "choice_email_attempt" DROP CONSTRAINT "choice_email_attempt_participant_id_participant_id_fk";
--> statement-breakpoint
ALTER TABLE "choice_email_attempt" DROP CONSTRAINT "choice_email_attempt_mentor_id_mentor_id_fk";
--> statement-breakpoint
ALTER TABLE "cohort" DROP CONSTRAINT "cohort_mentor_topic_id_mentor_topic_id_fk";
--> statement-breakpoint
ALTER TABLE "email_attempt" DROP CONSTRAINT "email_attempt_participant_id_participant_id_fk";
--> statement-breakpoint
ALTER TABLE "email_delivery_attempt" DROP CONSTRAINT "email_delivery_attempt_job_id_email_job_id_fk";
--> statement-breakpoint
ALTER TABLE "email_job" DROP CONSTRAINT "email_job_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "email_job" DROP CONSTRAINT "email_job_participant_id_participant_id_fk";
--> statement-breakpoint
ALTER TABLE "email_job" DROP CONSTRAINT "email_job_enrollment_id_enrollment_id_fk";
--> statement-breakpoint
ALTER TABLE "enrollment" DROP CONSTRAINT "enrollment_participant_id_participant_id_fk";
--> statement-breakpoint
ALTER TABLE "enrollment" DROP CONSTRAINT "enrollment_cohort_id_cohort_id_fk";
--> statement-breakpoint
ALTER TABLE "match" DROP CONSTRAINT "match_participant_id_participant_id_fk";
--> statement-breakpoint
ALTER TABLE "match" DROP CONSTRAINT "match_mentor_id_mentor_id_fk";
--> statement-breakpoint
ALTER TABLE "match" DROP CONSTRAINT "match_enrollment_id_enrollment_id_fk";
--> statement-breakpoint
ALTER TABLE "mentor_topic" DROP CONSTRAINT "mentor_topic_mentor_id_mentor_id_fk";
--> statement-breakpoint
ALTER TABLE "mentor_topic" DROP CONSTRAINT "mentor_topic_topic_id_topic_id_fk";
--> statement-breakpoint
ALTER TABLE "mentor" DROP CONSTRAINT "mentor_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "migration_issue" DROP CONSTRAINT "migration_issue_run_id_migration_run_id_fk";
--> statement-breakpoint
ALTER TABLE "migration_identity_link" DROP CONSTRAINT "migration_identity_link_run_id_migration_run_id_fk";
--> statement-breakpoint
ALTER TABLE "migration_identity_link" DROP CONSTRAINT "migration_identity_link_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "participant" DROP CONSTRAINT "participant_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "password_reset_token" DROP CONSTRAINT "password_reset_token_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "auth_session" DROP CONSTRAINT "auth_session_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "user_role" DROP CONSTRAINT "user_role_user_id_app_user_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_event" ADD CONSTRAINT "audit_event_actor_user_id_app_user_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "choice_email_attempt" ADD CONSTRAINT "choice_email_attempt_participant_id_participant_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "choice_email_attempt" ADD CONSTRAINT "choice_email_attempt_mentor_id_mentor_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."mentor"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cohort" ADD CONSTRAINT "cohort_mentor_topic_id_mentor_topic_id_fk" FOREIGN KEY ("mentor_topic_id") REFERENCES "public"."mentor_topic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_attempt" ADD CONSTRAINT "email_attempt_participant_id_participant_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_delivery_attempt" ADD CONSTRAINT "email_delivery_attempt_job_id_email_job_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."email_job"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_job" ADD CONSTRAINT "email_job_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_job" ADD CONSTRAINT "email_job_participant_id_participant_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_job" ADD CONSTRAINT "email_job_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_participant_id_participant_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollment" ADD CONSTRAINT "enrollment_cohort_id_cohort_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "public"."cohort"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_participant_id_participant_id_fk" FOREIGN KEY ("participant_id") REFERENCES "public"."participant"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_mentor_id_mentor_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."mentor"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match" ADD CONSTRAINT "match_enrollment_id_enrollment_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_topic" ADD CONSTRAINT "mentor_topic_mentor_id_mentor_id_fk" FOREIGN KEY ("mentor_id") REFERENCES "public"."mentor"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor_topic" ADD CONSTRAINT "mentor_topic_topic_id_topic_id_fk" FOREIGN KEY ("topic_id") REFERENCES "public"."topic"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mentor" ADD CONSTRAINT "mentor_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_issue" ADD CONSTRAINT "migration_issue_run_id_migration_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."migration_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_identity_link" ADD CONSTRAINT "migration_identity_link_run_id_migration_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."migration_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "migration_identity_link" ADD CONSTRAINT "migration_identity_link_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "participant" ADD CONSTRAINT "participant_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "password_reset_token" ADD CONSTRAINT "password_reset_token_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_session" ADD CONSTRAINT "auth_session_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_user_id_app_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."app_user"("id") ON DELETE restrict ON UPDATE no action;