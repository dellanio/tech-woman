-- WP-003: roles de Agenda. Operador aplica com role administrativa ANTES das migrations WP-003 (idempotente).
-- Nunca contém senha: LOGIN/senha da editora são definidos pelo operador fora do repositório.
-- Owner das funções de Agenda: NOLOGIN, sem BYPASSRLS/privilégios de cluster. A migradora é membro (SET para ALTER OWNER, INHERIT para
-- CREATE OR REPLACE de funções do owner em migrations seguintes); editora/runtime/mailer nunca são membros.
DO $$ BEGIN
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
 -- pgAdmin: BEGIN esquecido não segura o guard/site indefinidamente.
 ALTER ROLE techwoman_beatriz SET lock_timeout = '5s';
 ALTER ROLE techwoman_beatriz SET statement_timeout = '30s';
 ALTER ROLE techwoman_beatriz SET idle_in_transaction_session_timeout = '60s';
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_migrator') THEN
  GRANT techwoman_owner TO techwoman_migrator WITH INHERIT TRUE, SET TRUE;
 END IF;
END $$;
