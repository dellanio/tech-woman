/**
 * Bootstrap local (compose) com migradora NÃO superusuária e sem CREATEROLE: bootstrap-local.sql → agenda-privileges.sql → migrations → grants-local.sql,
 * repetição idempotente e grants efetivos; depois o MESMO arquivo scripts/migration/agenda-grants-matrix.sql do OPS executado no PG16 real,
 * inclusive provas de sensibilidade (uma concessão indevida faz a matriz falhar). Roles são globais do cluster de teste: criadas/restauradas aqui.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync,readdirSync} from 'node:fs';
import {Client,Pool} from 'pg';
import {migrate} from '../../scripts/migration/migrate';
import {tokenDigest} from '../../src/lib/db';
import {newSessionToken} from '../../src/lib/identity';

const base=process.env.MIGRATION_DATABASE_URL;
// INT-006: pg-pool resolve end() antes de o backend sair; aguardar pg_stat_activity antes do DROP ... WITH (FORCE)
const settled=async(control:Pool,name:string)=>{for(let i=0;i<80;i++){if(!(await control.query('select 1 from pg_stat_activity where datname=$1',[name])).rowCount)return;await new Promise(r=>setTimeout(r,50));}};
const MATRIX='scripts/migration/agenda-grants-matrix.sql';
const LOGIN_ROLES=['techwoman_migrator','techwoman_runtime','techwoman_mailer'] as const;
const I4_HELPERS=['internal.api_account_create(text,text)','internal.api_session_actor(text,uuid[])','internal.domain_lock_users(text,bigint[])','internal.lock_user_set(uuid[])','internal.lock_users(uuid,uuid)'];
const urlFor=(db:string,user?:string,password?:string)=>{const u=new URL(String(base));u.pathname='/'+db;if(user){u.username=user;u.password=password??'';}return u.toString();};
const redact=(text:string,secrets:string[])=>secrets.reduce((t,s)=>t.split(s).join('<redacted>'),text);
function psql(url:string,file:string,env:Record<string,string>={}){
 const r=spawnSync('psql',['-X','-q','-v','ON_ERROR_STOP=1','-f',file,url],{encoding:'utf8',env:{...process.env,...env}});
 return {status:r.status,out:`${r.stdout??''}\n${r.stderr??''}`};
}
async function connectAs(url:string){const c=new Client({connectionString:url});await c.connect();return c;}
const denied=async(c:Client,sql:string)=>assert.rejects(c.query(sql),(e:{code?:string})=>{assert.equal(e.code,'42501',sql);return true;});

test('bootstrap local: migradora sem SUPERUSER/CREATEROLE aplica migrations (owner NOLOGIN por membership), repetição idempotente, grants efetivos e matriz executável do OPS (com sensibilidade)',async()=>{
 assert.ok(base,'MIGRATION_DATABASE_URL de PG16 sintético');
 const control=new Pool({connectionString:base});const db='tw_boot_'+randomUUID().replace(/-/g,'');
 const prior=(await control.query('select rolname,rolcanlogin,rolpassword is not null has_password from pg_authid where rolname=any($1)',[LOGIN_ROLES])).rows as {rolname:string;rolcanlogin:boolean;has_password:boolean}[];
 const secrets={MIGRATOR_PASSWORD:randomBytes(18).toString('hex'),RUNTIME_PASSWORD:randomBytes(18).toString('hex'),MAILER_PASSWORD:randomBytes(18).toString('hex')};const hide=Object.values(secrets);
 const previousSetup=process.env.LOCAL_ROLE_SETUP;
 await control.query(`create database ${db}`);
 const clients:Client[]=[];
 try{
  // 1. bootstrap do volume vazio (role administrativa do entrypoint) + script do operador; os dois são reaplicáveis
  for(const file of ['scripts/migration/bootstrap-local.sql','scripts/migration/agenda-privileges.sql','scripts/migration/bootstrap-local.sql']){
   const r=psql(urlFor(db),file,secrets);assert.equal(r.status,0,`${file}: ${redact(r.out,hide)}`);
  }
  const bootstrap=readFileSync('scripts/migration/bootstrap-local.sql','utf8'),privileges=readFileSync('scripts/migration/agenda-privileges.sql','utf8').trim();
  assert.ok(bootstrap.includes(privileges),'bootstrap-local.sql contém literalmente agenda-privileges.sql (compose monta só o bootstrap)');
  const roles=(await control.query(`select rolname,rolsuper,rolcreaterole,rolcreatedb,rolbypassrls,rolreplication,rolcanlogin from pg_roles where rolname like 'techwoman%' order by rolname`)).rows;
  for(const r of roles)assert.deepEqual([r.rolname,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolbypassrls,r.rolreplication],[r.rolname,false,false,false,false,false]);
  assert.deepEqual(roles.filter(r=>r.rolcanlogin).map(r=>r.rolname),['techwoman_mailer','techwoman_migrator','techwoman_runtime'],'owner/editora NOLOGIN');
  const members=(await control.query(`select pg_get_userbyid(m.member) member,m.inherit_option,m.set_option from pg_auth_members m where m.roleid='techwoman_owner'::regrole`)).rows;
  assert.deepEqual(members,[{member:'techwoman_migrator',inherit_option:true,set_option:true}],'só a migradora é membro do owner (SET para ALTER OWNER, INHERIT para CREATE OR REPLACE)');
  // 2. migrations + grants locais como migradora; repetição é no-op
  process.env.LOCAL_ROLE_SETUP='1';
  const migratorUrl=urlFor(db,'techwoman_migrator',secrets.MIGRATOR_PASSWORD);
  await migrate(migratorUrl);
  const files=readdirSync('drizzle').filter(f=>f.endsWith('.sql')).length;
  const admin=await connectAs(urlFor(db));clients.push(admin);
  const applied=async()=>(await admin.query("select count(*)::int n,string_agg(checksum,'' order by name) s from internal.schema_migration")).rows[0];
  const first=await applied();assert.equal(first.n,files,'todas as migrations aplicadas pela migradora');
  await migrate(migratorUrl);assert.deepEqual(await applied(),first,'reaplicar é idempotente');
  assert.deepEqual((await admin.query(`select distinct pg_get_userbyid(relowner) o from pg_class where relnamespace in ('public'::regnamespace,'internal'::regnamespace) and relkind in ('r','v','S')`)).rows,[{o:'techwoman_migrator'}]);
  assert.deepEqual((await admin.query(`select distinct pg_get_userbyid(proowner) o from pg_proc where pronamespace='internal'::regnamespace order by 1`)).rows.map(r=>r.o),['techwoman_migrator','techwoman_owner']);
  assert.equal((await admin.query("select pg_get_userbyid(proowner) o from pg_proc where oid='internal.api_legacy_state(text)'::regprocedure")).rows[0].o,'techwoman_owner');
  // I4: helpers privilegiados novos/redefinidos no WP-003 pertencem ao owner NOLOGIN, não à migradora LOGIN
  const helpers=(await admin.query('select p.oid::regprocedure::text sig,pg_get_userbyid(p.proowner) o,r.rolcanlogin login,p.prosecdef from pg_proc p join pg_roles r on r.oid=p.proowner where p.oid=any($1::regprocedure[]) order by 1',[I4_HELPERS])).rows;
  assert.deepEqual(helpers.map(h=>[h.sig,h.o,h.login,h.prosecdef]),[...I4_HELPERS].sort().map(s=>[s,'techwoman_owner',false,true]));
  // T12/D-038: catálogo inteiro, sem allowlist — nenhuma SECURITY DEFINER da aplicação pertence a role LOGIN (inclusive as 41 WP-002 de identidade)
  const definers=(await admin.query(`select p.oid::regprocedure::text sig,pg_get_userbyid(p.proowner) o,r.rolcanlogin login,coalesce(p.proconfig,'{}') cfg from pg_proc p join pg_roles r on r.oid=p.proowner
   join pg_namespace n on n.oid=p.pronamespace where p.prosecdef and n.nspname not in ('pg_catalog','information_schema') order by 1`)).rows;
  assert.ok(definers.length>=100,`catálogo de SECURITY DEFINER inspecionado: ${definers.length}`);
  assert.deepEqual(definers.filter(d=>d.o!=='techwoman_owner'||d.login).map(d=>`${d.sig} → ${d.o}`),[],'toda SECURITY DEFINER pertence a techwoman_owner NOLOGIN');
  assert.deepEqual(definers.filter(d=>!(d.cfg as string[]).some(c=>/^search_path=pg_catalog(, [a-z_]+)*, pg_temp$/.test(c))).map(d=>d.sig),[],'search_path fixo em toda SECURITY DEFINER');
  for(const sig of ['internal.register_participant_account(text,text,text,jsonb,jsonb,text)','internal.identity_login_begin(text)','internal.email_claim(uuid)','internal.user_protected(uuid)'])
   assert.equal(definers.find(d=>d.sig===sig)?.o,'techwoman_owner',sig);
  // 3. sessões LOGIN reais (não superusuárias): troca de role negada; runtime só por funções
  const runtime=await connectAs(urlFor(db,'techwoman_runtime',secrets.RUNTIME_PASSWORD)),mailer=await connectAs(urlFor(db,'techwoman_mailer',secrets.MAILER_PASSWORD)),migrator=await connectAs(migratorUrl);clients.push(runtime,mailer,migrator);
  for(const c of [runtime,mailer])for(const role of ['techwoman_owner','techwoman_beatriz','techwoman_migrator','techwoman_runtime','techwoman_mailer'])
   {const self=(await c.query('select current_user u')).rows[0].u;if(self!==role)await denied(c,`set role ${role}`);}
  assert.equal((await runtime.query('select internal.api_legacy_state(null) r')).rows[0].r,null);
  await denied(runtime,'select * from app_user');await denied(runtime,'select * from topic');await denied(mailer,'select * from email_job');
  // I3: nem os grants locais reabrem DML/leitura de domínio para o runtime (só a home: event_content/demo_seed_state)
  for(const q of ['select * from participant','update participant set user_id=null','select * from mentor','select * from match',"insert into match(participant_id,mentor_id,score,reasons,status,origin) values(1,1,0,'[]','approved','legacy')"])await denied(runtime,q);
  await runtime.query('select * from event_content');await runtime.query('select * from demo_seed_state');
  // Owner NOLOGIN depois do ALTER OWNER (D-038): as funções de identidade leem a linha inteira de app_user (%ROWTYPE, hash para verificar senha),
  // então o owner tem SELECT nessas tabelas. A fronteira equivalente/mais forte: ninguém entra como owner (NOLOGIN; só a migradora faz SET ROLE),
  // e mesmo como owner não há DDL, TRUNCATE, DELETE de conta, troca de PK/chave, leitura de migrations/snapshot legado nem escrita fora das colunas das funções.
  await assert.rejects(connectAs(urlFor(db,'techwoman_owner','x')),'owner não faz login');
  await migrator.query('set role techwoman_owner');
  for(const q of ['delete from app_user','truncate app_user','truncate auth_session','update app_user set id=id','update app_user set created_at=created_at',
   'update auth_session set token_hash=token_hash','update password_reset_token set token_hash=token_hash','delete from auth_session','delete from email_job','update user_role set role=role',
   'update migration_identity_link set user_id=user_id','insert into migration_issue(id,run_id,source_table,source_key,code) values(gen_random_uuid(),gen_random_uuid(),$$x$$,$$x$$,$$x$$)',
   'delete from migration_identity_link','select * from internal.schema_migration','select * from legacy_snapshot.source_row','select * from migration_run',
   'create table internal.owner_forbidden(id int)','create table public.owner_forbidden(id int)','alter table app_user add column owner_x int','alter function internal.user_protected(uuid) owner to techwoman_runtime'])await denied(migrator,q);
  await migrator.query('reset role');
  const ownerAcl=(await admin.query(`select c.relname t,string_agg(distinct a.privilege_type,',' order by a.privilege_type) p from pg_class c,aclexplode(c.relacl) a
   where c.relnamespace='public'::regnamespace and a.grantee='techwoman_owner'::regrole and c.relname in ('app_user','user_role','auth_session','password_reset_token','email_job','email_delivery_attempt','api_idempotency','auth_rate_bucket','migration_identity_link','migration_issue') group by 1 order by 1`)).rows;
  assert.deepEqual(ownerAcl,[{t:'api_idempotency',p:'DELETE,SELECT'},{t:'app_user',p:'SELECT'},{t:'auth_rate_bucket',p:'DELETE,SELECT'},{t:'auth_session',p:'SELECT'},{t:'email_delivery_attempt',p:'SELECT'},
   {t:'email_job',p:'INSERT,SELECT'},{t:'migration_identity_link',p:'SELECT'},{t:'migration_issue',p:'SELECT'},{t:'password_reset_token',p:'SELECT'},{t:'user_role',p:'DELETE,SELECT'}],
   'tabela inteira: só SELECT (+DELETE onde a função apaga); INSERT/UPDATE do owner são só por coluna; nunca TRUNCATE/REFERENCES/TRIGGER');
  // fluxos reais sob migradora não superusuária: helpers do owner (sessão, lock de contas, conta nova, lock de domínio) e função WP-002 que chama lock_users
  const adminId=randomUUID(),target=randomUUID(),digest=tokenDigest(newSessionToken()),hash='a'.repeat(64);
  await admin.query("insert into app_user(id,email,status) values($1,'boot-admin@example.invalid','active'),($2,'boot-p@example.invalid','active')",[adminId,target]);
  await admin.query("insert into user_role(user_id,role) values($1,'admin'),($2,'participant')",[adminId,target]);
  await admin.query("insert into auth_session(id,user_id,token_hash,scope,session_version,expires_at) select gen_random_uuid(),id,$2,'full',session_version,now()+interval '1 hour' from app_user where id=$1",[adminId,digest]);
  const op=async(q:string,args:unknown[])=>(await runtime.query(q,args)).rows[0].r;
  assert.equal((await op('select internal.api_topic_create($1,$2,$3,$4,$5) r',[digest,randomUUID(),randomUUID(),hash,{slug:'boot-topic',name:'Boot'}])).slug,'boot-topic');
  const made=await op("select internal.api_admin_domain_create($1,$2,$3,$4,'participant',$5) r",[digest,randomUUID(),randomUUID(),hash,{email:'boot-new@example.invalid',goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true}]);
  assert.equal(made.email,'boot-new@example.invalid');
  assert.equal((await op('select internal.api_legacy_change($1,$2,$3) r',[digest,randomUUID(),{action:'remove-demo'}])).status,'0 mentoras de demonstração desativadas.');
  const version=(await admin.query('select version from app_user where id=$1',[target])).rows[0].version;
  assert.equal((await runtime.query('select o_outcome from internal.admin_user_disable($1,$2,$3,$4)',[digest,target,version,randomUUID()])).rows[0].o_outcome,'ok');
  // 4. matriz do OPS: o mesmo arquivo, executado de verdade
  let r=psql(urlFor(db),MATRIX);assert.equal(r.status,0,r.out);
  const counts=/MATRIX OK: (\d+) negações por privilégio executadas, (\d+) execuções permitidas, (\d+) verificações/.exec(r.out);assert.ok(counts,r.out);
  assert.ok(Number(counts[1])>=300&&Number(counts[2])>=10&&Number(counts[3])>=40,`matriz executa as negações de verdade: ${counts[0]}`);console.log(counts[0]);
  for(const [grant,revoke] of [
   ['grant select (email) on public.participant to techwoman_beatriz','revoke select (email) on public.participant from techwoman_beatriz'],
   ['grant truncate on public.enrollment to techwoman_beatriz','revoke truncate on public.enrollment from techwoman_beatriz'],
   // D-048: a editora é somente leitura — qualquer escrita por coluna, sequence, PUBLIC ou policy de escrita reabre o que a matriz nega
   ['grant update (capacity) on public.cohort to techwoman_beatriz','revoke update (capacity) on public.cohort from techwoman_beatriz'],
   ['grant insert (slug, name) on public.topic to techwoman_beatriz','revoke insert (slug, name) on public.topic from techwoman_beatriz'],
   ['grant usage on sequence public.topic_id_seq to techwoman_beatriz','revoke usage on sequence public.topic_id_seq from techwoman_beatriz'],
   ['grant update on public.participant_editor to techwoman_beatriz','revoke update on public.participant_editor from techwoman_beatriz'],
   ['grant delete on public.mentor_topic to public','revoke delete on public.mentor_topic from public'],
   ['create policy matrix_editor_write on public.topic for insert to techwoman_beatriz with check (true)','drop policy matrix_editor_write on public.topic'],
   ['grant execute on function internal.api_guard() to techwoman_runtime','revoke execute on function internal.api_guard() from techwoman_runtime'],
   ['grant execute on function internal.domain_lock_users(text,bigint[]) to public','revoke execute on function internal.domain_lock_users(text,bigint[]) from public'],
   ['grant select on public.auth_session to techwoman_runtime','revoke select on public.auth_session from techwoman_runtime'],
   ['alter table public.cohort no force row level security','alter table public.cohort force row level security'],
   ['alter function internal.api_legacy_state(text) reset search_path','alter function internal.api_legacy_state(text) set search_path = pg_catalog, pg_temp'],
   ['grant select, update on public.participant to techwoman_runtime','revoke select, update on public.participant from techwoman_runtime'],
   ['grant execute on function internal.domain_protected(text,bigint) to techwoman_runtime','revoke execute on function internal.domain_protected(text,bigint) from techwoman_runtime'],
   ['create policy matrix_runtime on public.participant for select to techwoman_runtime using (true)','drop policy matrix_runtime on public.participant'],
   ['alter function internal.lock_user_set(uuid[]) owner to techwoman_migrator','grant create on schema internal to techwoman_owner; alter function internal.lock_user_set(uuid[]) owner to techwoman_owner; revoke create on schema internal from techwoman_owner'],
   ['alter function internal.register_participant_account(text,text,text,jsonb,jsonb,text) owner to techwoman_migrator','grant create on schema internal to techwoman_owner; alter function internal.register_participant_account(text,text,text,jsonb,jsonb,text) owner to techwoman_owner; revoke create on schema internal from techwoman_owner'],
   ['alter function internal.identity_login_begin(text) owner to techwoman_migrator','grant create on schema internal to techwoman_owner; alter function internal.identity_login_begin(text) owner to techwoman_owner; revoke create on schema internal from techwoman_owner'],
  ] as const){
   await migrator.query(grant);
   r=psql(urlFor(db),MATRIX);
   await migrator.query(revoke);
   assert.notEqual(r.status,0,`matriz deveria falhar com: ${grant}`);assert.match(r.out,/MATRIX FAIL/,grant);assert.doesNotMatch(r.out,/MATRIX OK/);
  }
  // D-048: sem default_transaction_read_only=on da editora nesta base (setting de role: só a role administrativa altera) a matriz falha
  await admin.query(`alter role techwoman_beatriz in database ${db} reset default_transaction_read_only`);
  r=psql(urlFor(db),MATRIX);
  await admin.query(`alter role techwoman_beatriz in database ${db} set default_transaction_read_only = on`);
  assert.notEqual(r.status,0,'matriz deveria falhar sem o setting read-only da editora');assert.match(r.out,/MATRIX FAIL: editora: default_transaction_read_only=on/);assert.doesNotMatch(r.out,/MATRIX OK/);
  r=psql(urlFor(db),MATRIX);assert.equal(r.status,0,r.out);
  assert.equal((await admin.query("select count(*)::int n from app_user where email like 'matrix-%'")).rows[0].n,0,'fixtures da matriz desfeitas (ROLLBACK)');
 }finally{
  if(previousSetup===undefined)Reflect.deleteProperty(process.env,'LOCAL_ROLE_SETUP');else process.env.LOCAL_ROLE_SETUP=previousSetup;
  await Promise.all(clients.map(c=>c.end().catch(()=>undefined)));
  await settled(control,db);await control.query(`drop database if exists ${db} with (force)`);
  for(const role of LOGIN_ROLES){
   const before=prior.find(p=>p.rolname===role);
   if(!before)await control.query(`drop role if exists ${role}`);
   else await control.query(`alter role ${role} ${before.rolcanlogin?'LOGIN':'NOLOGIN'}${before.has_password?'':' PASSWORD NULL'}`);
  }
  await control.end();
 }
});
