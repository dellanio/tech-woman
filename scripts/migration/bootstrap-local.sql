-- Executado somente pelo entrypoint oficial PG de um volume local vazio (role administrativa do entrypoint), ANTES das migrations.
-- Nunca contém valores de senha nem é usado no host de produção. Reaplicável: roles existentes só têm atributos/senha reafirmados.
-- A migradora é NOSUPERUSER/NOCREATEROLE: as roles de Agenda e a membership migradora→owner vêm daqui (bloco idêntico a agenda-privileges.sql,
-- que o operador aplica em produção; o compose monta só este arquivo). Runtime/mailer/editora nunca são membros do owner.
\getenv migrator_password MIGRATOR_PASSWORD
\getenv runtime_password RUNTIME_PASSWORD
\getenv mailer_password MAILER_PASSWORD
SELECT format('CREATE ROLE %I NOLOGIN', r) FROM unnest(ARRAY['techwoman_migrator','techwoman_runtime','techwoman_mailer']) r WHERE NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = r) \gexec
SELECT format('ALTER ROLE techwoman_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'migrator_password') \gexec
SELECT format('ALTER ROLE techwoman_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'runtime_password') \gexec
SELECT format('ALTER ROLE techwoman_mailer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', :'mailer_password') \gexec
SELECT format('GRANT CREATE ON DATABASE %I TO techwoman_migrator', current_database()) \gexec
GRANT ALL ON SCHEMA public TO techwoman_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
-- >>> início do conteúdo literal de scripts/migration/agenda-privileges.sql
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
-- <<< fim do conteúdo literal de scripts/migration/agenda-privileges.sql
