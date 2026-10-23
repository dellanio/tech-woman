-- WP-002 Task 3 (A) RED: stubs do predicado de proteção (sempre falso); a implementação real chega no GREEN.
CREATE OR REPLACE FUNCTION internal.privileged_email_keys() RETURNS TABLE(ekey text)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT NULL::text WHERE false; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.user_protected(p_user uuid) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT false; $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION internal.domain_protected(p_table text, p_id bigint) RETURNS boolean
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT false; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.privileged_email_keys(), internal.user_protected(uuid), internal.domain_protected(text,bigint) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_runtime') THEN
  GRANT USAGE ON SCHEMA internal TO techwoman_runtime;
  GRANT EXECUTE ON FUNCTION internal.user_protected(uuid), internal.domain_protected(text,bigint) TO techwoman_runtime;
 END IF;
END $$;
