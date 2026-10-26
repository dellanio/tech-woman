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
-- Owner de TODA função SECURITY DEFINER da aplicação (Agenda e identidade/fila, D-038): NOLOGIN, sem BYPASSRLS/privilégios de cluster.
-- A migradora é membro (SET para ALTER OWNER, INHERIT para CREATE OR REPLACE de funções do owner em migrations seguintes); editora/runtime/mailer nunca são membros.
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
 -- D-048: editora somente leitura (sem DML desde 20261026140000_beatriz_read_only.sql); toda sessão LOGIN nova nasce read-only.
 -- SET ROLE não carrega este setting: a barreira continua sendo o privilégio, o setting é a primeira camada (PF-ROLE-LIMITS exige on).
 EXECUTE format('ALTER ROLE techwoman_beatriz IN DATABASE %I SET default_transaction_read_only = %L', current_database(), 'on');
 IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'techwoman_migrator') THEN
  GRANT techwoman_owner TO techwoman_migrator WITH INHERIT TRUE, SET TRUE;
 END IF;
 -- PUBLIC sem USAGE em public (preflight C8); cada role da aplicação recebe USAGE explícito (validate_agenda_state depende dele).
 REVOKE USAGE ON SCHEMA public FROM PUBLIC;
 FOR r IN SELECT rolname FROM pg_catalog.pg_roles WHERE rolname IN ('techwoman_runtime','techwoman_mailer','techwoman_migrator','techwoman_owner','techwoman_beatriz') ORDER BY rolname LOOP
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', r.rolname);
 END LOOP;
END $$;
-- <<< fim do conteúdo literal de scripts/migration/agenda-privileges.sql
