-- WP-005 S12: read-only T12 checks of the techwoman database (run by ops/preflight.py inside READ ONLY).
-- One JSON object, one entry per stable check id, each with the number of offending objects ("bad"). Only counts
-- leave the database (no role password, no row content), except PF-OTHER-DB: the names of the other connectable
-- databases go to ops/preflight.py, which tries a REAL connection of each techwoman role to each of them (D-040) and
-- prints only counts; a name is never printed.
with roles(r) as (values ('techwoman_runtime'), ('techwoman_mailer'), ('techwoman_beatriz'))
select json_build_object(
 'PF-ROLE-FLAGS', json_build_object('bad',
   (select count(*) from pg_roles p join roles on p.rolname = roles.r
     where p.rolsuper or p.rolcreaterole or p.rolcreatedb or p.rolbypassrls or p.rolreplication)
   + 3 - (select count(*) from pg_roles p join roles on p.rolname = roles.r)),
 -- the three application roles are members of nothing (no inherited runtime/migrator/owner, no SET ROLE)
 'PF-ROLE-MEMBER', json_build_object('bad',
   (select count(*) from pg_auth_members a join pg_roles m on m.oid = a.member join roles on m.rolname = roles.r)),
 'PF-PUBLIC-SCHEMA', json_build_object('bad',
   (select count(*) from (values ('public', 'USAGE'), ('public', 'CREATE'), ('internal', 'USAGE'), ('internal', 'CREATE'),
                                 ('legacy_snapshot', 'USAGE'), ('legacy_snapshot', 'CREATE')) v(n, p)
     where exists (select 1 from pg_namespace where nspname = v.n) and has_schema_privilege('public', v.n, v.p))),
 'PF-PUBLIC-FUNC', json_build_object('bad',
   (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'internal', 'legacy_snapshot')
       and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')
       and (has_function_privilege('public', p.oid, 'EXECUTE')
            or (p.prosecdef and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))))),
 'PF-DEFPRIV', json_build_object('bad',
   (select count(*) from pg_default_acl d where exists (select 1 from aclexplode(d.defaclacl) a where a.grantee = 0))),
 -- the three finite timeouts set for each role IN THIS DATABASE (ops/sql/role-limits.sql)
 'PF-ROLE-LIMITS', json_build_object('bad',
   (select count(*) from roles where (
      select count(*) from pg_db_role_setting s, unnest(s.setconfig) c
       where s.setrole = (select oid from pg_roles where rolname = roles.r)
         and s.setdatabase = (select oid from pg_database where datname = current_database())
         and split_part(c, '=', 1) in ('lock_timeout', 'statement_timeout', 'idle_in_transaction_session_timeout')
         and split_part(c, '=', 2) !~ '^0+([a-z]+)?$') <> 3)),
 -- D-040: no ACL predicate (PUBLIC keeps CONNECT on databases of other services and is never revoked here);
 -- isolation is proven by the connection attempts of ops/preflight.py against these targets.
 'PF-OTHER-DB', json_build_object('databases',
   (select coalesce(json_agg(d.datname order by d.datname), '[]'::json) from pg_database d
     where d.datallowconn and not d.datistemplate and d.datname <> current_database())),
 -- pg_hba: no broken line, and the FIRST TCP rule reaching each role for this database demands scram-sha-256/cert
 'PF-HBA', json_build_object('bad',
   (select count(*) from pg_hba_file_rules where error is not null)
   + (select count(*) from roles where coalesce((
        select h.auth_method from pg_hba_file_rules h
         where h.type like 'host%' and h.error is null
           and h.user_name && array['all', roles.r]::text[] and h.database && array['all', current_database()]::text[]
         order by h.line_number limit 1), 'none') not in ('scram-sha-256', 'cert')))
)
