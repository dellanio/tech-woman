-- WP-002 Task 3 (B) RED: stub do limitador (sempre permite); a implementação real chega no GREEN.
CREATE OR REPLACE FUNCTION internal.rate_hit(p_key text, p_limit integer, p_window integer) RETURNS TABLE(o_allowed boolean, o_retry integer)
LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$ SELECT true, 0; $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.rate_hit(text,integer,integer) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.rate_hit(text,integer,integer) TO techwoman_runtime;
 END IF;
END $$;
