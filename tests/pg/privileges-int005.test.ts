/**
 * INT-005 (pedidos R-009/R-010 do WP-005): o bootstrap/agenda-privileges reflete a produção.
 * - R-009: PUBLIC sem USAGE em `public`; cada role techwoman_* recebe USAGE explícito (senão validate_agenda_state quebra).
 * - R-010: timeouts da editora valem só IN DATABASE (nenhum valor global que vaze para outras bases do cluster).
 * Roles são globais do cluster de teste sintético; senhas aleatórias geradas aqui e nunca impressas.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../scripts/migration/migrate';

const base=process.env.MIGRATION_DATABASE_URL;
// INT-006: pg-pool resolve end() antes de o backend sair; aguardar pg_stat_activity antes do DROP ... WITH (FORCE)
const settled=async(control:Pool,name:string)=>{for(let i=0;i<80;i++){if(!(await control.query('select 1 from pg_stat_activity where datname=$1',[name])).rowCount)return;await new Promise(r=>setTimeout(r,50));}};
const ROLES=['techwoman_migrator','techwoman_runtime','techwoman_mailer','techwoman_owner','techwoman_beatriz'];
const TIMEOUTS=['lock_timeout','statement_timeout','idle_in_transaction_session_timeout'];
const urlFor=(db:string,user?:string,password?:string)=>{const u=new URL(String(base));u.pathname='/'+db;if(user){u.username=user;u.password=password??'';}return u.toString();};
function psql(url:string,file:string,env:Record<string,string>){
 const r=spawnSync('psql',['-X','-q','-v','ON_ERROR_STOP=1','-f',file,url],{encoding:'utf8',env:{...process.env,...env}});
 return {status:r.status,out:`${r.stdout??''}\n${r.stderr??''}`};
}

test('R-009/R-010: bootstrap revoga USAGE de PUBLIC em public com USAGE explícito por role e timeouts da editora só IN DATABASE',async()=>{
 assert.ok(base,'MIGRATION_DATABASE_URL de PG16 sintético');
 const control=new Pool({connectionString:base});const db='tw_priv_'+randomUUID().replace(/-/g,'');
 const secrets={MIGRATOR_PASSWORD:randomBytes(18).toString('hex'),RUNTIME_PASSWORD:randomBytes(18).toString('hex'),MAILER_PASSWORD:randomBytes(18).toString('hex')};
 const hide=(t:string)=>Object.values(secrets).reduce((s,x)=>s.split(x).join('<redacted>'),t);
 // estado global legado (script antigo): a reaplicação precisa limpá-lo
 await control.query(`do $$ begin if not exists (select 1 from pg_roles where rolname='techwoman_beatriz') then create role techwoman_beatriz nologin; end if; end $$`);
 await control.query(`alter role techwoman_beatriz set lock_timeout='5s'`);
 await control.query(`create database ${db}`);
 const admin=new Pool({connectionString:urlFor(db)});
 try{
  for(const file of ['scripts/migration/bootstrap-local.sql','scripts/migration/agenda-privileges.sql']){const r=psql(urlFor(db),file,secrets);assert.equal(r.status,0,`${file}: ${hide(r.out)}`);}
  const globalCfg=(await control.query(`select coalesce(s.setconfig,'{}') cfg from pg_db_role_setting s where s.setrole='techwoman_beatriz'::regrole and s.setdatabase=0`)).rows[0]?.cfg as string[]|undefined;
  for(const k of TIMEOUTS)assert.equal((globalCfg??[]).some(x=>x.startsWith(k+'=')),false,`${k} global da editora removido (R-010)`);
  const dbCfg=(await control.query(`select s.setconfig cfg from pg_db_role_setting s join pg_database d on d.oid=s.setdatabase where s.setrole='techwoman_beatriz'::regrole and d.datname=$1`,[db])).rows[0]?.cfg as string[]|undefined;
  for(const k of TIMEOUTS){const v=(dbCfg??[]).find(x=>x.startsWith(k+'='));assert.ok(v&&!/=0$/.test(v),`${k} finito IN DATABASE: ${v}`);}
  const publicUsage=(await admin.query(`select exists(select 1 from pg_namespace n, aclexplode(coalesce(n.nspacl,acldefault('n',n.nspowner))) a where n.nspname='public' and a.grantee=0 and a.privilege_type in ('USAGE','CREATE')) x`)).rows[0].x;
  assert.equal(publicUsage,false,'PUBLIC sem USAGE/CREATE em public (R-009)');
  for(const role of ROLES)assert.equal((await admin.query(`select has_schema_privilege($1,'public','USAGE') ok`,[role])).rows[0].ok,true,`${role} com USAGE explícito em public`);
  // migrations pela migradora não superusuária continuam funcionando sem o USAGE de PUBLIC
  process.env.LOCAL_ROLE_SETUP='1';
  await migrate(urlFor(db,'techwoman_migrator',secrets.MIGRATOR_PASSWORD));
  const runtime=new Pool({connectionString:urlFor(db,'techwoman_runtime',secrets.RUNTIME_PASSWORD)});
  try{assert.equal((await runtime.query('select internal.api_legacy_state(null) r')).rows[0].r,null,'runtime opera sem USAGE de PUBLIC');}finally{await runtime.end();}
 }finally{
  delete process.env.LOCAL_ROLE_SETUP;
  await admin.end();await settled(control,db);await control.query(`drop database if exists ${db} with (force)`);await control.end();
 }
});
