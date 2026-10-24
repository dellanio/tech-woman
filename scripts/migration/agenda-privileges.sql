-- WP-003: roles de Agenda. Operador aplica com role administrativa ANTES das migrations WP-003 (idempotente).
-- Nunca contém senha: LOGIN/senha da editora são definidos pelo operador fora do repositório.
-- Owner das funções de Agenda: NOLOGIN, sem BYPASSRLS/privilégios de cluster. A migradora é membro (SET para ALTER OWNER, INHERIT para
-- CREATE OR REPLACE de funções do owner em migrations seguintes); editora/runtime/mailer nunca são membros.
DO $$ DECLARE r record; BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_owner') THEN
  CREATE ROLE techwoman_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 ELSE
  ALTER ROLE techwoman_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 END IF;
 IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_beatriz') THEN
  CREATE ROLE techwoman_beatriz NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 ELSE
  ALTER ROLE techwoman_beatriz NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
 END IF;
 -- pgAdmin: BEGIN esquecido não segura o guard/site indefinidamente. Limites só nesta base (IN DATABASE, mesmos valores de
 -- ops/sql/role-limits.sql); valores globais legados são removidos para não vazar para outras bases do cluster.
 ALTER ROLE techwoman_beatriz RESET lock_timeout;
 ALTER ROLE techwoman_beatriz RESET statement_timeout;
 ALTER ROLE techwoman_beatriz RESET idle_in_transaction_session_timeout;
 EXECUTE format('ALTER ROLE techwoman_beatriz IN DATABASE %I SET lock_timeout = %L', current_database(), '10s');
 EXECUTE format('ALTER ROLE techwoman_beatriz IN DATABASE %I SET statement_timeout = %L', current_database(), '60s');
 EXECUTE format('ALTER ROLE techwoman_beatriz IN DATABASE %I SET idle_in_transaction_session_timeout = %L', current_database(), '30s');
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_migrator') THEN
  GRANT techwoman_owner TO techwoman_migrator WITH INHERIT TRUE, SET TRUE;
 END IF;
 -- PUBLIC sem USAGE em public (preflight C8); cada role da aplicação recebe USAGE explícito (validate_agenda_state depende dele).
 REVOKE USAGE ON SCHEMA public FROM PUBLIC;
 FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('techwoman_runtime','techwoman_mailer','techwoman_migrator','techwoman_owner','techwoman_beatriz') ORDER BY rolname LOOP
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r.rolname);
 END LOOP;
END $$;
