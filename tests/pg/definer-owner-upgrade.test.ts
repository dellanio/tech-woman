/**
 * FIX-DB T2 (D-038, G3-03/T12): upgrade real de uma base no estado dd09ce5 (migrations anteriores ao FIX-DB) para o journal atual,
 * sempre pela migradora LOGIN NOSUPERUSER/NOCREATEROLE com bootstrap real. Depois do upgrade: toda SECURITY DEFINER pertence a
 * techwoman_owner NOLOGIN com search_path fixo, EXECUTE de runtime/mailer/editora/PUBLIC idêntico ao de antes, checksums antigos
 * intactos, reaplicação idempotente, e os fluxos de identidade (login, cadastro, sessão) e do worker (claim/emissão) continuam
 * funcionando como LOGIN reais sobre dados criados antes do upgrade.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtempSync,mkdirSync,readdirSync,symlinkSync,rmSync} from 'node:fs';

import {join,resolve} from 'node:path';
import {Pool} from 'pg';
import {migrate} from '../../scripts/migration/migrate';
import {closeDb,hashPassword} from '../../src/lib/db';
import * as identity from '../../src/lib/identity';
import * as registration from '../../src/lib/registration';
import * as email from '../../src/lib/email';

const base=process.env.MIGRATION_DATABASE_URL;
const LOGIN_ROLES=['techwoman_migrator','techwoman_runtime','techwoman_mailer'] as const;
const FIX_DB_FIRST='20261025130000';
const ENV_KEYS=['DATABASE_URL','MAILER_DATABASE_URL','SESSION_SECRET','APP_ORIGIN','EMAIL_MODE','SES_SEND_ENABLED','LOCAL_ROLE_SETUP','MENTOR_DEADLINE'] as const;
const settled=async(control:Pool,name:string)=>{for(let i=0;i<80;i++){if(!(await control.query('select 1 from pg_stat_activity where datname=$1',[name])).rowCount)return;await new Promise(r=>setTimeout(r,50));}};
const urlFor=(db:string,user?:string,password?:string)=>{const u=new URL(String(base));u.pathname='/'+db;if(user){u.username=user;u.password=password??'';}return u.toString();};
const redact=(text:string,secrets:string[])=>secrets.reduce((t,s)=>t.split(s).join('<redacted>'),text);

/** EXECUTE efetivo (has_function_privilege) de cada role não-dona sobre toda função de internal/public. */
const executeMap=async(db:Pool)=>(await db.query(`select p.oid::regprocedure::text sig,r.g grantee from pg_proc p cross join (values ('techwoman_runtime'),('techwoman_mailer'),('techwoman_beatriz'),('public')) r(g)
 where p.pronamespace in ('internal'::regnamespace,'public'::regnamespace) and has_function_privilege(r.g,p.oid,'EXECUTE') order by 1,2`)).rows.map(r=>`${r.sig} ${r.grantee}`);
const definerOwners=async(db:Pool)=>(await db.query(`select p.oid::regprocedure::text sig,pg_get_userbyid(p.proowner) o,r.rolcanlogin login,coalesce(p.proconfig,'{}') cfg from pg_proc p join pg_roles r on r.oid=p.proowner
 where p.prosecdef and p.pronamespace in ('internal'::regnamespace,'public'::regnamespace) order by 1`)).rows as {sig:string;o:string;login:boolean;cfg:string[]}[];

test('upgrade dd09ce5 → FIX-DB pela migradora LOGIN não superusuária: owner NOLOGIN em toda SECURITY DEFINER, EXECUTE inalterado, identidade e worker funcionando',async()=>{
 assert.ok(base,'MIGRATION_DATABASE_URL de PG16 sintético');
 const control=new Pool({connectionString:base});const name='tw_fixdb_up_'+randomUUID().replace(/-/g,'');
 const prior=(await control.query('select rolname,rolcanlogin,rolpassword is not null has_password from pg_authid where rolname=any($1)',[LOGIN_ROLES])).rows as {rolname:string;rolcanlogin:boolean;has_password:boolean}[];
 const previousEnv=Object.fromEntries(ENV_KEYS.map(k=>[k,process.env[k]]));
 const secrets={MIGRATOR_PASSWORD:randomBytes(18).toString('hex'),RUNTIME_PASSWORD:randomBytes(18).toString('hex'),MAILER_PASSWORD:randomBytes(18).toString('hex')};
 const cwd=process.cwd();mkdirSync(resolve('data/fix-db'),{recursive:true});const old=mkdtempSync(resolve('data/fix-db/old-'));
 await control.query(`create database ${name}`);
 const admin=new Pool({connectionString:urlFor(name),max:4});
 try{
  const r=spawnSync('psql',['-X','-q','-v','ON_ERROR_STOP=1','-f','scripts/migration/bootstrap-local.sql',urlFor(name)],{encoding:'utf8',env:{...process.env,...secrets}});
  assert.equal(r.status,0,redact(`${r.stdout}\n${r.stderr}`,Object.values(secrets)));
  assert.deepEqual((await control.query("select rolsuper,rolcreaterole,rolcanlogin from pg_roles where rolname='techwoman_migrator'")).rows[0],{rolsuper:false,rolcreaterole:false,rolcanlogin:true});
  const migratorUrl=urlFor(name,'techwoman_migrator',secrets.MIGRATOR_PASSWORD);
  // 1. estado dd09ce5: árvore com as mesmas migrations (symlinks) menos as do FIX-DB
  const all=readdirSync('drizzle').filter(f=>f.endsWith('.sql')).sort();const previous=all.filter(f=>f<FIX_DB_FIRST);
  assert.ok(previous.length<all.length,'há migrations novas do FIX-DB para aplicar no upgrade');
  mkdirSync(join(old,'drizzle'));mkdirSync(join(old,'scripts/migration'),{recursive:true});
  for(const f of previous)symlinkSync(resolve('drizzle',f),join(old,'drizzle',f));
  symlinkSync(resolve('scripts/migration/grants-local.sql'),join(old,'scripts/migration/grants-local.sql'));
  process.env.LOCAL_ROLE_SETUP='1';
  process.chdir(old);try{await migrate(migratorUrl);}finally{process.chdir(cwd);}
  const before=await definerOwners(admin);
  assert.ok(before.some(d=>d.login),'estado antigo reproduzido: há SECURITY DEFINER com owner LOGIN (G3-03)');
  const execBefore=await executeMap(admin);
  const checksBefore=(await admin.query('select name,checksum from internal.schema_migration order by name')).rows;
  assert.equal(checksBefore.length,previous.length);
  // dados criados ANTES do upgrade: conta ativa com senha e job de cadastro pendente
  const pw=`pw-${randomBytes(12).toString('base64url')}`,userId=randomUUID();
  await admin.query("insert into app_user(id,email,status,password_hash) values($1,'antes@example.invalid','active',$2)",[userId,await hashPassword(pw)]);
  await admin.query("insert into user_role(user_id,role) values($1,'participant')",[userId]);
  // 2. upgrade para o journal atual, mesma migradora; repetição é no-op
  await migrate(migratorUrl);
  const checksAfter=(await admin.query('select name,checksum from internal.schema_migration order by name')).rows;
  assert.deepEqual(checksAfter.slice(0,checksBefore.length),checksBefore,'checksums das migrations aplicadas intactos');
  assert.deepEqual(checksAfter.map(c=>c.name),all.map(f=>f),'todas as migrations novas registradas');
  await migrate(migratorUrl);
  assert.deepEqual((await admin.query('select name,checksum from internal.schema_migration order by name')).rows,checksAfter,'reaplicar é idempotente');
  Reflect.deleteProperty(process.env,'LOCAL_ROLE_SETUP');
  const after=await definerOwners(admin);
  assert.deepEqual(after.map(d=>d.sig),before.map(d=>d.sig),'mesmo conjunto de SECURITY DEFINER');
  assert.deepEqual(after.filter(d=>d.o!=='techwoman_owner'||d.login).map(d=>`${d.sig} → ${d.o}`),[],'toda SECURITY DEFINER pertence a techwoman_owner NOLOGIN');
  assert.deepEqual(after.filter(d=>!d.cfg.some(c=>/^search_path=pg_catalog(, [a-z_]+)*, pg_temp$/.test(c))).map(d=>d.sig),[],'search_path fixo');
  assert.deepEqual(await executeMap(admin),execBefore,'EXECUTE de runtime/mailer/editora/PUBLIC idêntico ao de antes (nenhum acesso novo)');
  assert.deepEqual((await admin.query("select rolcanlogin,rolsuper,rolbypassrls,rolcreaterole,rolcreatedb,rolreplication from pg_roles where rolname='techwoman_owner'")).rows[0],
   {rolcanlogin:false,rolsuper:false,rolbypassrls:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false});
  assert.equal((await admin.query("select has_schema_privilege('techwoman_owner','internal','CREATE') c")).rows[0].c,false,'CREATE temporário do owner revogado');
  // 3. fluxos reais como LOGIN (runtime web e worker) sobre dados anteriores ao upgrade
  Object.assign(process.env,{DATABASE_URL:urlFor(name,'techwoman_runtime',secrets.RUNTIME_PASSWORD),MAILER_DATABASE_URL:urlFor(name,'techwoman_mailer',secrets.MAILER_PASSWORD),
   SESSION_SECRET:randomBytes(48).toString('hex'),APP_ORIGIN:'http://app.example.invalid',EMAIL_MODE:'fake',SES_SEND_ENABLED:'0',MENTOR_DEADLINE:'2999-12-31T23:59:59.000Z'});
  await closeDb();await email.closeEmailPool();
  const session=await identity.login('ANTES@example.invalid ',pw);assert.ok(session,'login de conta anterior ao upgrade');
  assert.ok(await identity.identitySession(session.token),'sessão validada pelo owner');
  assert.equal(await identity.login('antes@example.invalid','senha-errada-123'),null);
  assert.deepEqual(await registration.registerParticipant({email:'Depois@Example.invalid',goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true}),{status:'received',next:'check_email'});
  assert.deepEqual(await identity.requestPasswordForgot('antes@example.invalid'),{status:'received'});
  const to:string[]=[];const worker=await email.runEmailWorkerOnce(email.createMemoryTransport(m=>{to.push(m.to.toLowerCase());}));
  assert.deepEqual([worker.simulated,worker.accepted,worker.failed],[2,0,0],'worker emite cadastro + reset em memória');
  assert.deepEqual(to.sort(),['antes@example.invalid','depois@example.invalid']);
  const u=(await admin.query("select status,temporary_password_hash is not null th,must_change_password m from app_user where email_key='depois@example.invalid'")).rows[0];
  assert.deepEqual(u,{status:'pending_activation',th:true,m:true},'emissão do temporário pelo owner gravou só o hash');
  assert.equal((await admin.query("select count(*)::int n from password_reset_token where user_id=$1",[userId])).rows[0].n,1);
 }finally{
  process.chdir(cwd);rmSync(old,{recursive:true,force:true});
  await closeDb();await email.closeEmailPool();
  for(const k of ENV_KEYS){const v=previousEnv[k];if(v===undefined)Reflect.deleteProperty(process.env,k);else Reflect.set(process.env,k,v);}
  await admin.end();await settled(control,name);await control.query(`drop database if exists ${name} with (force)`);
  for(const role of LOGIN_ROLES){
   const p=prior.find(x=>x.rolname===role);
   if(!p)await control.query(`drop role if exists ${role}`).catch(()=>undefined);
   else await control.query(`alter role ${role} ${p.rolcanlogin?'LOGIN':'NOLOGIN'}${p.has_password?'':' PASSWORD NULL'}`);
  }
  await control.end();
 }
});
