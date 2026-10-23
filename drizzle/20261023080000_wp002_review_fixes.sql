-- WP-002 revisão final: correções por RED/GREEN (migrations anteriores já aplicadas não são editadas).
-- I2: o service legado precisa travar o(s) dono(s) da linha de domínio ANTES do predicado, como o CRUD e a elevação offline (app_user FOR UPDATE).
CREATE OR REPLACE FUNCTION internal.lock_domain_owner(p_table text, p_id bigint) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_user uuid; v_key text;
BEGIN
 IF p_table = 'participant' THEN SELECT d.user_id, lower(btrim(d.email)) INTO v_user, v_key FROM public.participant d WHERE d.id = p_id;
 ELSIF p_table = 'mentor' THEN SELECT d.user_id, lower(btrim(d.email)) INTO v_user, v_key FROM public.mentor d WHERE d.id = p_id;
 ELSE RETURN; END IF;
 IF NOT FOUND THEN RETURN; END IF;
 -- FOR SHARE espera a elevação offline (FOR UPDATE) terminar; ordem por id evita deadlock entre lockers.
 PERFORM 1 FROM public.app_user a WHERE a.id = v_user OR a.email_key = v_key ORDER BY a.id FOR SHARE;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.lock_domain_owner(text,bigint) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_runtime') THEN
  GRANT EXECUTE ON FUNCTION internal.lock_domain_owner(text,bigint) TO techwoman_runtime;
 END IF;
END $$;
