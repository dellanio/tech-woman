-- WP-002 Task 3 (B): limitador de taxa atômico no PG (compartilhado entre processos). A chave já chega como HMAC; o banco nunca vê e-mail/IP.
CREATE OR REPLACE FUNCTION internal.rate_hit(p_key text, p_limit integer, p_window integer) RETURNS TABLE(o_allowed boolean, o_retry integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_count integer; v_expires timestamptz;
BEGIN
 IF p_key IS NULL OR p_key !~ '^[A-Za-z0-9_-]{43}$' OR p_limit IS NULL OR p_limit < 1 OR p_window IS NULL OR p_window < 1 OR p_window > 86400 THEN RAISE EXCEPTION 'invalid rate bucket'; END IF;
 INSERT INTO public.auth_rate_bucket AS b (bucket_key, window_start, count, expires_at) VALUES (p_key, now(), 1, now() + make_interval(secs => p_window))
 ON CONFLICT (bucket_key) DO UPDATE SET
  window_start = CASE WHEN b.expires_at <= now() THEN now() ELSE b.window_start END,
  count = CASE WHEN b.expires_at <= now() THEN 1 ELSE b.count + 1 END,
  expires_at = CASE WHEN b.expires_at <= now() THEN now() + make_interval(secs => p_window) ELSE b.expires_at END
 RETURNING b.count, b.expires_at INTO v_count, v_expires;
 IF random() < 0.01 THEN DELETE FROM public.auth_rate_bucket WHERE expires_at < now() - interval '1 hour'; END IF;
 RETURN QUERY SELECT v_count <= p_limit, CASE WHEN v_count <= p_limit THEN 0 ELSE least(p_window, greatest(1, ceil(extract(epoch FROM v_expires - clock_timestamp()))::integer)) END;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.rate_hit(text,integer,integer) FROM PUBLIC;
--> statement-breakpoint
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='techwoman_runtime') THEN
  GRANT USAGE ON SCHEMA internal TO techwoman_runtime;
  GRANT EXECUTE ON FUNCTION internal.rate_hit(text,integer,integer) TO techwoman_runtime;
 END IF;
END $$;
