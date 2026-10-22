-- Executado somente pelo entrypoint oficial PG de um volume local vazio.
-- Nunca contém valores de senha nem é usado no host de produção.
\getenv migrator_password MIGRATOR_PASSWORD
\getenv runtime_password RUNTIME_PASSWORD
\getenv mailer_password MAILER_PASSWORD
SELECT format('CREATE ROLE techwoman_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'migrator_password') \gexec
SELECT format('CREATE ROLE techwoman_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'runtime_password') \gexec
SELECT format('CREATE ROLE techwoman_mailer LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L', :'mailer_password') \gexec
GRANT CREATE ON DATABASE techwoman TO techwoman_migrator;
GRANT ALL ON SCHEMA public TO techwoman_migrator;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
