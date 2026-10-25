/**
 * FIX-DB T1 (D-037, G3-02): cadastro público em chave protegida SÓ pelo mapa da migração (sem app_user e sem domínio).
 * Bootstrap real (bootstrap-local.sql), migrations pela migradora LOGIN NOSUPERUSER/NOCREATEROLE, runtime e worker como LOGIN reais.
 * Handlers v1 e adapters antigos de participante/mentora × privileged_candidate / credential_conflict / pendência (migration_issue),
 * chave do mapa e e-mail do pedido com caixa/espaço diferentes: 202 com corpo idêntico ao de um e-mail livre, nenhuma linha de
 * identidade/domínio/fila muda, e o worker (transporte em memória) não envia nada para chave protegida.
 */
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {Pool} from 'pg';
import {migrate} from '../../scripts/migration/migrate';
import {closeDb} from '../../src/lib/db';
import * as email from '../../src/lib/email';
import * as v1Participants from '../../src/app/api/v1/registrations/participants/route';
import * as v1Mentors from '../../src/app/api/v1/registrations/mentors/route';
import * as legacyParticipant from '../../src/app/api/participant/route';
import * as legacyMentor from '../../src/app/api/mentor/route';
import {call,type Reply} from './identity-http-kit.test';

const base=process.env.MIGRATION_DATABASE_URL;
const LOGIN_ROLES=['techwoman_migrator','techwoman_runtime','techwoman_mailer'] as const;
const ENV_KEYS=['DATABASE_URL','MAILER_DATABASE_URL','SESSION_SECRET','APP_ORIGIN','EMAIL_MODE','SES_SEND_ENABLED','MENTOR_DEADLINE','RATE_IP_PER_HOUR','LOCAL_ROLE_SETUP','TRUST_PROXY'] as const;
const settled=async(control:Pool,name:string)=>{for(let i=0;i<80;i++){if(!(await control.query('select 1 from pg_stat_activity where datname=$1',[name])).rowCount)return;await new Promise(r=>setTimeout(r,50));}};
const urlFor=(db:string,user?:string,password?:string)=>{const u=new URL(String(base));u.pathname='/'+db;if(user){u.username=user;u.password=password??'';}return u.toString();};
const redact=(text:string,secrets:string[])=>secrets.reduce((t,s)=>t.split(s).join('<redacted>'),text);

const participantBody=(addr:string)=>({email:addr,goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true});
const v1MentorBody=(addr:string)=>({email:addr,displayName:'Mentora Fictícia',trajectory:'Trajetória sintética',specialties:['dados'],availability:'Quartas',legacyCapacity:3,consent:true});
const legacyMentorBody=(addr:string)=>({email:addr,trajectory:'Trajetória sintética',specialties:['dados'],availability:'Quartas',capacity:3,consent:true});
const ENTRIES:{name:string;send:(addr:string)=>Promise<Reply>}[]=[
 {name:'v1-participant',send:addr=>call(v1Participants.POST,'/api/v1/registrations/participants',{body:participantBody(addr),key:randomUUID()})},
 {name:'v1-mentor',send:addr=>call(v1Mentors.POST,'/api/v1/registrations/mentors',{body:v1MentorBody(addr),key:randomUUID()})},
 {name:'legacy-participant',send:addr=>call(legacyParticipant.POST,'/api/participant',{body:participantBody(addr)})},
 {name:'legacy-mentor',send:addr=>call(legacyMentor.POST,'/api/mentor',{body:legacyMentorBody(addr)})},
];
const KINDS=['privileged_candidate','credential_conflict','pending'] as const;

let control:Pool,admin:Pool,dbName:string,prior:{rolname:string;rolcanlogin:boolean;has_password:boolean}[]=[];
const previousEnv=Object.fromEntries(ENV_KEYS.map(k=>[k,process.env[k]]));

before(async()=>{
 assert.ok(base,'MIGRATION_DATABASE_URL de PG16 sintético');
 control=new Pool({connectionString:base});dbName='tw_fixdb_reg_'+randomUUID().replace(/-/g,'');
 prior=(await control.query('select rolname,rolcanlogin,rolpassword is not null has_password from pg_authid where rolname=any($1)',[LOGIN_ROLES])).rows;
 await control.query(`create database ${dbName}`);
 const secrets={MIGRATOR_PASSWORD:randomBytes(18).toString('hex'),RUNTIME_PASSWORD:randomBytes(18).toString('hex'),MAILER_PASSWORD:randomBytes(18).toString('hex')};
 const r=spawnSync('psql',['-X','-q','-v','ON_ERROR_STOP=1','-f','scripts/migration/bootstrap-local.sql',urlFor(dbName)],{encoding:'utf8',env:{...process.env,...secrets}});
 assert.equal(r.status,0,redact(`${r.stdout}\n${r.stderr}`,Object.values(secrets)));
 const migrator=(await control.query("select rolsuper,rolcreaterole,rolcanlogin from pg_roles where rolname='techwoman_migrator'")).rows[0];
 assert.deepEqual(migrator,{rolsuper:false,rolcreaterole:false,rolcanlogin:true},'migradora de produção: LOGIN NOSUPERUSER NOCREATEROLE');
 process.env.LOCAL_ROLE_SETUP='1';
 await migrate(urlFor(dbName,'techwoman_migrator',secrets.MIGRATOR_PASSWORD));
 Reflect.deleteProperty(process.env,'LOCAL_ROLE_SETUP');
 admin=new Pool({connectionString:urlFor(dbName),max:4});
 Object.assign(process.env,{DATABASE_URL:urlFor(dbName,'techwoman_runtime',secrets.RUNTIME_PASSWORD),MAILER_DATABASE_URL:urlFor(dbName,'techwoman_mailer',secrets.MAILER_PASSWORD),
  SESSION_SECRET:randomBytes(48).toString('hex'),APP_ORIGIN:'http://app.example.invalid',EMAIL_MODE:'fake',SES_SEND_ENABLED:'0',MENTOR_DEADLINE:'2999-12-31T23:59:59.000Z',RATE_IP_PER_HOUR:'1000'});
 Reflect.deleteProperty(process.env,'TRUST_PROXY');
});

after(async()=>{
 await closeDb();await email.closeEmailPool();
 for(const k of ENV_KEYS){const v=previousEnv[k];if(v===undefined)Reflect.deleteProperty(process.env,k);else Reflect.set(process.env,k,v);}
 await admin?.end();
 if(control){
  await settled(control,dbName);await control.query(`drop database if exists ${dbName} with (force)`);
  for(const role of LOGIN_ROLES){
   const p=prior.find(x=>x.rolname===role);
   if(!p)await control.query(`drop role if exists ${role}`).catch(()=>undefined);
   else await control.query(`alter role ${role} ${p.rolcanlogin?'LOGIN':'NOLOGIN'}${p.has_password?'':' PASSWORD NULL'}`);
  }
  await control.end();
 }
});

/** Identidade, domínio, fila e mapa inteiros (linha a linha). api_idempotency/auth_rate_bucket ficam fora: são do pedido, idênticos para chave livre e protegida. */
const snapshot=async()=>JSON.stringify((await admin.query(`select
 (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from app_user x) users,(select coalesce(jsonb_agg(to_jsonb(x) order by user_id,role),'[]') from user_role x) roles,
 (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from participant x) participants,(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from mentor x) mentors,
 (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from email_job x) jobs,(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from email_delivery_attempt x) attempts,
 (select coalesce(jsonb_agg(to_jsonb(x) order by token_hash),'[]') from password_reset_token x) resets,(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from auth_session x) sessions,
 (select coalesce(jsonb_agg(to_jsonb(x) order by source_table,source_key),'[]') from migration_identity_link x) links,(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from migration_issue x) issues`)).rows[0]);
const keyRows=async(key:string)=>(await admin.query(`select (select count(*)::int from app_user where email_key=$1) users,(select count(*)::int from participant where lower(btrim(email))=$1) participants,
 (select count(*)::int from mentor where lower(btrim(email))=$1) mentors,(select count(*)::int from email_job j join app_user u on u.id=j.user_id where u.email_key=$1) jobs`,[key])).rows[0];
const comparable=(r:Reply)=>JSON.stringify({status:r.status,body:r.json?.data??r.json,cache:r.headers.get('cache-control'),type:r.headers.get('content-type')});

test('cadastro público em chave protegida só pelo mapa: 202 idêntico ao livre, nenhuma mutação, nenhum envio (4 entradas × 3 resoluções, caixa/espaço)',async()=>{
 const run=randomUUID();await admin.query("insert into migration_run(id,source_checksum,status) values($1,$2,'pending')",[run,'fixdb-'+run]);
 const tag=randomBytes(3).toString('hex');
 const protectedKeys:string[]=[],freeKeys:string[]=[];
 for(const entry of ENTRIES)for(const kind of KINDS){
  const key=`${kind.replace('_','-')}.${entry.name}.${tag}@example.invalid`;protectedKeys.push(key);
  // mapa com caixa/espaço diferentes do pedido; nenhum app_user nem linha de domínio com essa chave
  const stored=`  ${key.toUpperCase()} `;
  if(kind==='pending')await admin.query("insert into migration_issue(id,run_id,source_table,source_key,code) values(gen_random_uuid(),$1,'admin_user',$2,'UNSUPPORTED_CREDENTIAL')",[run,stored]);
  else await admin.query("insert into migration_identity_link(run_id,source_table,source_key,user_id,resolution) values($1,'admin_user',$2,null,$3)",[run,stored,kind]);
  assert.deepEqual(await keyRows(key),{users:0,participants:0,mentors:0,jobs:0},'fixture: chave existe só no mapa');
 }
 const results:Record<string,unknown>[]=[];
 for(const entry of ENTRIES){
  const freeKey=`livre.${entry.name}.${tag}@example.invalid`;freeKeys.push(freeKey);
  const free=await entry.send(`  ${freeKey.replace('livre','Livre')} `.trim());
  assert.equal(free.status,202,`${entry.name}: cadastro livre aceito`);
  assert.equal((await keyRows(freeKey)).users,1,`${entry.name}: controle livre cria a conta pendente (o caminho realmente escreve)`);
  for(const kind of KINDS){
   const key=`${kind.replace('_','-')}.${entry.name}.${tag}@example.invalid`;
   const beforeSnap=await snapshot();
   const reply=await entry.send(`${key.slice(0,1).toUpperCase()}${key.slice(1)}`);
   const afterSnap=await snapshot();
   const row={entry:entry.name,kind,status:reply.status,identical_to_free:comparable(reply)===comparable(free),unchanged:beforeSnap===afterSnap,...await keyRows(key)};
   results.push(row);
  }
 }
 let messages=0;const recipients:string[]=[];
 const worker=await email.runEmailWorkerOnce(email.createMemoryTransport(m=>{messages++;recipients.push(m.to.trim().toLowerCase());}));
 const protectedSent=recipients.filter(r=>protectedKeys.includes(r)).length;
 const protectedCredentials=(await admin.query('select count(*)::int n from app_user where email_key=any($1) and (temporary_password_hash is not null or password_hash is not null)',[protectedKeys])).rows[0].n;
 console.log(JSON.stringify({results,worker:{simulated:worker.simulated,accepted:worker.accepted},memory_messages:messages,protected_sent:protectedSent,protected_credentials:protectedCredentials}));
 assert.equal(worker.accepted,0,'transporte em memória: nada aceito por provedor real');
 assert.equal(messages,freeKeys.length,'só os cadastros livres geram mensagem (em memória)');
 assert.deepEqual([...recipients].sort(),[...freeKeys].sort());
 for(const r of results)assert.deepEqual(r,{...r,status:202,identical_to_free:true,unchanged:true,users:0,participants:0,mentors:0,jobs:0},`MUST T07/D-037: ${r.entry} × ${r.kind}`);
 assert.equal(protectedSent,0);assert.equal(protectedCredentials,0);
});

test('semântica conservadora reutilizada: pendência resolvida e ambiguous_domain não bloqueiam; repetição livre continua neutra',async()=>{
 const run=randomUUID();await admin.query("insert into migration_run(id,source_checksum,status) values($1,$2,'pending')",[run,'fixdb-ok-'+run]);
 const tag=randomBytes(3).toString('hex');
 const resolved=`resolvida.${tag}@example.invalid`,ambiguous=`ambigua.${tag}@example.invalid`;
 await admin.query("insert into migration_issue(id,run_id,source_table,source_key,code,resolved_at) values(gen_random_uuid(),$1,'admin_user',$2,'UNSUPPORTED_CREDENTIAL',now())",[run,resolved]);
 await admin.query("insert into migration_identity_link(run_id,source_table,source_key,user_id,resolution) values($1,'admin_user',$2,null,'ambiguous_domain')",[run,ambiguous]);
 for(const addr of [resolved,ambiguous]){
  const r=await ENTRIES[0].send(addr);assert.equal(r.status,202);
  assert.equal((await keyRows(addr)).users,1,`${addr}: não é chave protegida pelo predicado existente (privileged_email_keys)`);
  const snap=await snapshot();const again=await ENTRIES[2].send(addr.toUpperCase());assert.equal(again.status,202);assert.equal(await snapshot(),snap,'duplicata continua sem mutação');
 }
});
