-- WP-003 correção final I2: regras de formato do contrato no banco, resistentes ao DML da editora (DER: checks são migrations reais).
-- topic é tabela nova do WP-003 (sem legado): CHECK validado. slug ASCII minúsculo kebab 1..80 (imutável), name 1..120 não vazio, description ≤1000.
ALTER TABLE public.topic
 ADD CONSTRAINT topic_slug_format CHECK (length(slug) BETWEEN 1 AND 80 AND slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
 ADD CONSTRAINT topic_name_length CHECK (length(btrim(name)) BETWEEN 1 AND 120 AND length(name) <= 120),
 ADD CONSTRAINT topic_description_length CHECK (length(description) <= 1000);
--> statement-breakpoint
-- participant/mentor têm legado importado incomum (enums/área livres, arrays vazios, textos com espaços, display_name NULL) que deve ser preservado
-- byte a byte. Decisão mínima (DER: "novas entradas validadas"): só UPDATE é validado, e só nas colunas de perfil cujo valor mudou; UPDATE de
-- active/outra coluna não revalida histórico. INSERT de perfil só existe no importador/dono e nas funções da API/cadastro (que já validam o DTO);
-- a editora não tem INSERT nessas tabelas. Mesmas regras do contrato v1/cadastro público (area 'outra: <texto 1..80>' como o serviço grava).
-- Função de trigger sem SECURITY DEFINER e sem chamadas a outras funções (a editora não executa nada de internal além do predicado de RLS).
CREATE OR REPLACE FUNCTION internal.agenda_profile_format() RETURNS trigger
LANGUAGE plpgsql VOLATILE SET search_path = pg_catalog, pg_temp AS $$
DECLARE v_tags constant text[] := ARRAY['produto','dados','desenvolvimento','design']; v_skills constant text[] := ARRAY['comunicacao','analise','codigo','gestao'];
 v_bad boolean := false; v_other text;
BEGIN
 IF TG_TABLE_NAME = 'participant' THEN
  v_bad := (NEW.goal IS DISTINCT FROM OLD.goal AND NOT coalesce(NEW.goal IN ('transition','growth','leadership'), false))
   OR (NEW.moment IS DISTINCT FROM OLD.moment AND NOT coalesce(NEW.moment IN ('starting','working','returning'), false));
  IF NOT v_bad AND NEW.area IS DISTINCT FROM OLD.area THEN
   IF NEW.area IS NULL THEN v_bad := true;
   ELSIF NEW.area <> ALL (v_tags) THEN
    v_other := CASE WHEN left(NEW.area, 7) = 'outra: ' THEN substr(NEW.area, 8) END;
    v_bad := v_other IS NULL OR length(btrim(v_other)) NOT BETWEEN 1 AND 80 OR length(v_other) > 80;
   END IF;
  END IF;
  IF NOT v_bad AND NEW.interests IS DISTINCT FROM OLD.interests THEN
   IF NEW.interests IS NULL OR jsonb_typeof(NEW.interests) <> 'array' THEN v_bad := true;
   ELSE
    v_bad := jsonb_array_length(NEW.interests) NOT BETWEEN 1 AND 3
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.interests) e WHERE jsonb_typeof(e) <> 'string' OR NOT ((e #>> '{}') = ANY (v_tags)))
     OR (SELECT count(DISTINCT e) FROM jsonb_array_elements(NEW.interests) e) <> jsonb_array_length(NEW.interests);
   END IF;
  END IF;
  IF NOT v_bad AND NEW.skills IS DISTINCT FROM OLD.skills THEN
   IF NEW.skills IS NULL OR jsonb_typeof(NEW.skills) <> 'array' THEN v_bad := true;
   ELSE
    v_bad := jsonb_array_length(NEW.skills) NOT BETWEEN 1 AND 4
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.skills) e WHERE jsonb_typeof(e) <> 'string' OR NOT ((e #>> '{}') = ANY (v_skills)))
     OR (SELECT count(DISTINCT e) FROM jsonb_array_elements(NEW.skills) e) <> jsonb_array_length(NEW.skills);
   END IF;
  END IF;
  IF v_bad THEN RAISE EXCEPTION 'participant_profile_format' USING ERRCODE = 'check_violation', CONSTRAINT = 'participant_profile_format'; END IF;
 ELSIF TG_TABLE_NAME = 'mentor' THEN
  v_bad := (NEW.display_name IS DISTINCT FROM OLD.display_name AND NEW.display_name IS NOT NULL AND (length(btrim(NEW.display_name)) NOT BETWEEN 1 AND 120 OR length(NEW.display_name) > 120))
   OR (NEW.trajectory IS DISTINCT FROM OLD.trajectory AND NOT coalesce(length(btrim(NEW.trajectory)) BETWEEN 1 AND 1000 AND length(NEW.trajectory) <= 1000, false))
   OR (NEW.availability IS DISTINCT FROM OLD.availability AND NOT coalesce(length(btrim(NEW.availability)) BETWEEN 1 AND 300 AND length(NEW.availability) <= 300, false))
   OR (NEW.capacity IS DISTINCT FROM OLD.capacity AND NOT coalesce(NEW.capacity BETWEEN 1 AND 50, false));
  IF NOT v_bad AND NEW.specialties IS DISTINCT FROM OLD.specialties THEN
   IF NEW.specialties IS NULL OR jsonb_typeof(NEW.specialties) <> 'array' THEN v_bad := true;
   ELSE
    v_bad := jsonb_array_length(NEW.specialties) NOT BETWEEN 1 AND 3
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.specialties) e WHERE jsonb_typeof(e) <> 'string' OR NOT ((e #>> '{}') = ANY (v_tags)))
     OR (SELECT count(DISTINCT e) FROM jsonb_array_elements(NEW.specialties) e) <> jsonb_array_length(NEW.specialties);
   END IF;
  END IF;
  IF v_bad THEN RAISE EXCEPTION 'mentor_profile_format' USING ERRCODE = 'check_violation', CONSTRAINT = 'mentor_profile_format'; END IF;
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION internal.agenda_profile_format() FROM PUBLIC;
GRANT CREATE ON SCHEMA internal TO techwoman_owner;
ALTER FUNCTION internal.agenda_profile_format() OWNER TO techwoman_owner;
REVOKE CREATE ON SCHEMA internal FROM techwoman_owner;
--> statement-breakpoint
CREATE TRIGGER agenda_profile_format BEFORE UPDATE OF goal, moment, interests, skills, area ON public.participant FOR EACH ROW EXECUTE FUNCTION internal.agenda_profile_format();
CREATE TRIGGER agenda_profile_format BEFORE UPDATE OF display_name, trajectory, specialties, availability, capacity ON public.mentor FOR EACH ROW EXECUTE FUNCTION internal.agenda_profile_format();
