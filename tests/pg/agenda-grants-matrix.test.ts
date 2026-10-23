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

const base=process.env.MIGRATION_DATABASE_URL;
const MATRIX='scripts/migration/agenda-grants-matrix.sql';
const LOGIN_ROLES=['techwoman_migrator','techwoman_runtime','techwoman_mailer'] as const;
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
  // 3. sessões LOGIN reais (não superusuárias): troca de role negada; runtime só por funções
  const runtime=await connectAs(urlFor(db,'techwoman_runtime',secrets.RUNTIME_PASSWORD)),mailer=await connectAs(urlFor(db,'techwoman_mailer',secrets.MAILER_PASSWORD)),migrator=await connectAs(migratorUrl);clients.push(runtime,mailer,migrator);
  for(const c of [runtime,mailer])for(const role of ['techwoman_owner','techwoman_beatriz','techwoman_migrator','techwoman_runtime','techwoman_mailer'])
   {const self=(await c.query('select current_user u')).rows[0].u;if(self!==role)await denied(c,`set role ${role}`);}
  assert.equal((await runtime.query('select internal.api_legacy_state(null) r')).rows[0].r,null);
  await denied(runtime,'select * from app_user');await denied(runtime,'select * from topic');await denied(mailer,'select * from email_job');
  await migrator.query('set role techwoman_owner');await denied(migrator,'select * from app_user');await migrator.query('reset role');
  // 4. matriz do OPS: o mesmo arquivo, executado de verdade
  let r=psql(urlFor(db),MATRIX);assert.equal(r.status,0,r.out);assert.match(r.out,/MATRIX OK/);
  for(const [grant,revoke] of [
   ['grant select (email) on public.participant to techwoman_beatriz','revoke select (email) on public.participant from techwoman_beatriz'],
   ['grant truncate on public.enrollment to techwoman_beatriz','revoke truncate on public.enrollment from techwoman_beatriz'],
   ['grant execute on function internal.api_guard() to techwoman_runtime','revoke execute on function internal.api_guard() from techwoman_runtime'],
   ['grant execute on function internal.domain_lock_users(text,bigint[]) to public','revoke execute on function internal.domain_lock_users(text,bigint[]) from public'],
   ['grant select on public.auth_session to techwoman_runtime','revoke select on public.auth_session from techwoman_runtime'],
   ['alter table public.cohort no force row level security','alter table public.cohort force row level security'],
   ['alter function internal.api_legacy_state(text) reset search_path','alter function internal.api_legacy_state(text) set search_path = pg_catalog, pg_temp'],
  ] as const){
   await migrator.query(grant);
   r=psql(urlFor(db),MATRIX);
   await migrator.query(revoke);
   assert.notEqual(r.status,0,`matriz deveria falhar com: ${grant}`);assert.match(r.out,/MATRIX FAIL/,grant);assert.doesNotMatch(r.out,/MATRIX OK/);
  }
  r=psql(urlFor(db),MATRIX);assert.equal(r.status,0,r.out);
  assert.equal((await admin.query("select count(*)::int n from app_user where email like 'matrix-%'")).rows[0].n,0,'fixtures da matriz desfeitas (ROLLBACK)');
 }finally{
  if(previousSetup===undefined)Reflect.deleteProperty(process.env,'LOCAL_ROLE_SETUP');else process.env.LOCAL_ROLE_SETUP=previousSetup;
  await Promise.all(clients.map(c=>c.end().catch(()=>undefined)));
  await control.query(`drop database if exists ${db} with (force)`);
  for(const role of LOGIN_ROLES){
   const before=prior.find(p=>p.rolname===role);
   if(!before)await control.query(`drop role if exists ${role}`);
   else await control.query(`alter role ${role} ${before.rolcanlogin?'LOGIN':'NOLOGIN'}${before.has_password?'':' PASSWORD NULL'}`);
  }
  await control.end();
 }
});
