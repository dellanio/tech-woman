-- WP-005 S11: finite lock/statement/idle-in-transaction limits for the Tech Woman roles, scoped to THIS database
-- (ALTER ROLE ... IN DATABASE): neighbour databases of the shared cluster keep their own settings.
-- Applied by the operator (OPS-002) with an administrative role, inside the PostgreSQL container:
--   docker exec -i <pg container> psql -X -v ON_ERROR_STOP=1 -U <admin> -d techwoman -f - < role-limits.sql
-- Idempotent. Values may be overridden with -v name=value (e.g. -v beatriz_idle=45s); each must be a finite
-- interval > 0 and <= 1 hour, otherwise nothing is changed. Values arrive as psql literals (:'x'), never as SQL.
-- Login settings apply to NEW login sessions only: restart the web/mailer pools after applying.
\set ON_ERROR_STOP on
\if :{?runtime_lock}   \else \set runtime_lock 5s \endif
\if :{?runtime_statement} \else \set runtime_statement 15s \endif
\if :{?runtime_idle}   \else \set runtime_idle 10s \endif
\if :{?mailer_lock}    \else \set mailer_lock 5s \endif
\if :{?mailer_statement} \else \set mailer_statement 15s \endif
\if :{?mailer_idle}    \else \set mailer_idle 10s \endif
\if :{?beatriz_lock}   \else \set beatriz_lock 10s \endif
\if :{?beatriz_statement} \else \set beatriz_statement 60s \endif
\if :{?beatriz_idle}   \else \set beatriz_idle 30s \endif

BEGIN;
-- Validation first: a non-interval, zero, negative or over-long value aborts the whole transaction.
CREATE TEMP TABLE tw_role_limits(role name, setting text, value text) ON COMMIT DROP;
INSERT INTO tw_role_limits VALUES
 ('techwoman_runtime', 'lock_timeout', :'runtime_lock'),
 ('techwoman_runtime', 'statement_timeout', :'runtime_statement'),
 ('techwoman_runtime', 'idle_in_transaction_session_timeout', :'runtime_idle'),
 ('techwoman_mailer', 'lock_timeout', :'mailer_lock'),
 ('techwoman_mailer', 'statement_timeout', :'mailer_statement'),
 ('techwoman_mailer', 'idle_in_transaction_session_timeout', :'mailer_idle'),
 ('techwoman_beatriz', 'lock_timeout', :'beatriz_lock'),
 ('techwoman_beatriz', 'statement_timeout', :'beatriz_statement'),
 ('techwoman_beatriz', 'idle_in_transaction_session_timeout', :'beatriz_idle');
DO $$
DECLARE r record;
BEGIN
 FOR r IN SELECT * FROM tw_role_limits LOOP
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r.role) THEN
   RAISE EXCEPTION 'role-limits: role % does not exist', r.role;
  END IF;
  IF r.value !~ '^[0-9]{1,6}(ms|s|min|h)$' OR r.value::interval <= interval '0' OR r.value::interval > interval '1 hour' THEN
   RAISE EXCEPTION 'role-limits: % for % must be a finite interval > 0 and <= 1h', r.setting, r.role;
  END IF;
 END LOOP;
 FOR r IN SELECT * FROM tw_role_limits LOOP
  EXECUTE format('ALTER ROLE %I IN DATABASE %I SET %s = %L', r.role, current_database(), r.setting, r.value);
 END LOOP;
END $$;
COMMIT;
