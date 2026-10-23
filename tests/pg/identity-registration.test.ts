import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {migrate} from '../../scripts/migration/migrate';
import {closeDb,hashPassword} from '../../src/lib/db';
import * as contracts from '../../src/lib/contracts';
import * as registration from '../../src/lib/registration';

const base=process.env.MIGRATION_DATABASE_URL;
type Ctx={db:Pool;url:string};
const synthetic=()=>`pw-${randomBytes(12).toString('base64url')}`;
const roleUrl=(url:string,role:string)=>{const u=new URL(url);u.searchParams.set('options',`-c role=${role}`);return u.toString();};

/** Banco isolado; o app roda de verdade como techwoman_runtime (SET ROLE na conexão), as fixtures como dono. */
async function withDb(fn:(ctx:Ctx)=>Promise<void>){
 assert.ok(base,'MIGRATION_DATABASE_URL');const control=new Pool({connectionString:base});const name='tw_reg_'+randomUUID().replace(/-/g,'');
 const created:string[]=[];
 for(const role of ['techwoman_runtime','techwoman_mailer']){ if(!(await control.query('select 1 from pg_roles where rolname=$1',[role])).rowCount){await control.query(`create role ${role} nologin`);created.push(role);} }
 await control.query(`create database ${name}`);const u=new URL(base);u.pathname='/'+name;const url=u.toString();
 const db=new Pool({connectionString:url,max:6});const previous=process.env.DATABASE_URL;const deadline=process.env.MENTOR_DEADLINE;
 try{ await migrate(url);await closeDb();process.env.DATABASE_URL=roleUrl(url,'techwoman_runtime');await fn({db,url}); }
 finally{ await closeDb();if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;if(deadline===undefined)delete process.env.MENTOR_DEADLINE;else process.env.MENTOR_DEADLINE=deadline;
  await db.end();await control.query(`drop database ${name} with (force)`);for(const role of created)await control.query(`drop role if exists ${role}`).catch(()=>undefined);await control.end(); }
}
const participantDto=(email:string,extra:Record<string,unknown>={})=>({email,goal:'transition',moment:'starting',interests:['dados','design'],skills:['analise'],area:'outra',otherArea:'Educação',consent:true,...extra});
const mentorDto=(email:string,extra:Record<string,unknown>={})=>({email,displayName:'Mentora Fictícia',trajectory:'Trajetória de teste',specialties:['produto'],availability:'Quartas à tarde',legacyCapacity:3,consent:true,...extra});
const counts=async(db:Pool)=>(await db.query(`select (select count(*)::int from app_user) users,(select count(*)::int from user_role) roles,(select count(*)::int from participant) participants,(select count(*)::int from mentor) mentors,(select count(*)::int from email_job) jobs`)).rows[0];
const snapshot=async(db:Pool)=>JSON.stringify((await db.query(`select (select coalesce(jsonb_agg(to_jsonb(u) order by id),'[]') from app_user u) users,(select coalesce(jsonb_agg(to_jsonb(r) order by user_id,role),'[]') from user_role r) roles,(select coalesce(jsonb_agg(to_jsonb(p) order by id),'[]') from participant p) participants,(select coalesce(jsonb_agg(to_jsonb(m) order by id),'[]') from mentor m) mentors,(select coalesce(jsonb_agg(to_jsonb(j) order by id),'[]') from email_job j) jobs`)).rows[0]);
const same=(a:string,b:string)=>a===b;

test('contratos públicos: resposta genérica, DTOs fechados de perfil e esqueci-senha',()=>{
 assert.deepEqual(contracts.registrationReceived,{status:'received',next:'check_email'});
 const bad=(fn:()=>unknown)=>{try{fn();return null}catch(e){return e instanceof contracts.ContractError?[...e.fields].sort():'UNEXPECTED'}};
 assert.deepEqual(bad(()=>contracts.parseParticipantProfile(participantDto('x@example.invalid'))),['email']);
 assert.deepEqual(bad(()=>contracts.parseParticipantProfile({...participantDto('x@example.invalid'),roles:['admin'],userId:'1'})),['email','roles','userId']);
 assert.deepEqual(bad(()=>contracts.parseMentorProfile(mentorDto('x@example.invalid'))),['email']);
 const {email:_p,...pBody}=participantDto('x@example.invalid');assert.equal(bad(()=>contracts.parseParticipantProfile(pBody)),null);
 assert.deepEqual(contracts.parseParticipantProfile(pBody),{goal:'transition',moment:'starting',interests:['dados','design'],skills:['analise'],area:'outra',otherArea:'Educação',consent:true});
 const {email:_m,...mBody}=mentorDto('x@example.invalid');assert.equal(bad(()=>contracts.parseMentorProfile(mBody)),null);
 assert.deepEqual(bad(()=>contracts.parseMentorProfile({...mBody,consent:false})),['consent']);
 assert.deepEqual(contracts.parsePasswordForgot({email:'  Ana@Example.invalid '}),{email:'Ana@Example.invalid'});
 assert.deepEqual(bad(()=>contracts.parsePasswordForgot({email:'ana@example.invalid',role:'admin'})),['role']);
 assert.deepEqual(bad(()=>contracts.parsePasswordForgot({email:'sem-arroba'})),['email']);
});

test('cadastro novo de participante: usuário pendente, papel, perfil ligado e intenção de e-mail sem payload',async()=>withDb(async({db})=>{
 const out=await registration.registerParticipant(participantDto('  Nova.Pessoa@Example.invalid '));
 assert.deepEqual(out,{status:'received',next:'check_email'});
 assert.deepEqual(await counts(db),{users:1,roles:1,participants:1,mentors:0,jobs:1});
 const u=(await db.query(`select id,email,email_key,status,password_hash is null ph,temporary_password_hash is null th,must_change_password m,credential_generation::int g from app_user`)).rows[0];
 assert.deepEqual([u.email,u.email_key,u.status,u.ph,u.th,u.m,u.g],['Nova.Pessoa@Example.invalid','nova.pessoa@example.invalid','pending_activation',true,true,false,0]);
 assert.deepEqual((await db.query('select role from user_role where user_id=$1',[u.id])).rows,[{role:'participant'}]);
 const p=(await db.query(`select user_id,email,goal,moment,interests,skills,area,consent_version,consent_at is not null c,token_hash ~ '^[a-f0-9]{64}$' th,legacy_access_revoked_at is null ok,active from participant`)).rows[0];
 assert.deepEqual([p.user_id,p.email,p.goal,p.moment,p.interests,p.skills,p.area,p.consent_version,p.c,p.th,p.ok,p.active],[u.id,'Nova.Pessoa@Example.invalid','transition','starting',['dados','design'],['analise'],'outra: Educação','v1',true,true,true,true]);
 const j=(await db.query(`select user_id,kind,status,generation::int g,attempts,lease_owner is null lo,participant_id::text pid from email_job`)).rows[0];
 assert.deepEqual([j.user_id,j.kind,j.status,j.g,j.attempts,j.lo],[u.id,'registration','queued',0,0,true]);
 assert.equal(j.pid,(await db.query('select id::text from participant')).rows[0].id);
 const second=await registration.registerParticipant(participantDto('outra@example.invalid'));assert.deepEqual(second,out);
 const hashes=(await db.query('select count(distinct token_hash)::int n from participant')).rows[0].n;assert.equal(hashes,2,'token_hash aleatório e único por registro, nunca exposto');
}));

test('cadastro novo de mentora: perfil ligado e prazo verificado antes de qualquer consulta',async()=>withDb(async({db})=>{
 const runtimeUrl=process.env.DATABASE_URL!;
 const out=await registration.registerMentor(mentorDto('mentora@example.invalid'));assert.deepEqual(out,{status:'received',next:'check_email'});
 assert.deepEqual(await counts(db),{users:1,roles:1,participants:0,mentors:1,jobs:1});
 const m=(await db.query(`select m.user_id=u.id linked,m.email,m.display_name,m.trajectory,m.specialties,m.availability,m.capacity,m.active,m.demo,m.consent_version,m.consent_at is not null c,(select role from user_role r where r.user_id=u.id) role,u.status from mentor m join app_user u on true`)).rows[0];
 assert.deepEqual(m,{linked:true,email:'mentora@example.invalid',display_name:'Mentora Fictícia',trajectory:'Trajetória de teste',specialties:['produto'],availability:'Quartas à tarde',capacity:3,active:true,demo:false,consent_version:'v1',c:true,role:'mentor',status:'pending_activation'});
 assert.equal((await db.query("select kind from email_job")).rows[0].kind,'registration');
 process.env.MENTOR_DEADLINE='2020-01-01T00:00:00.000Z';
 await closeDb();process.env.DATABASE_URL='postgres://nobody@127.0.0.1:1/none';
 const outcome=await registration.registerMentor(mentorDto('tarde@example.invalid')).then(()=>'resolved',e=>e instanceof registration.RegistrationClosedError?`${e.status}:${e.code}`:'UNEXPECTED');
 assert.equal(outcome,'403:REGISTRATION_CLOSED','fechado devolve 403 sem tocar o banco (URL inalcançável)');
 await closeDb();process.env.DATABASE_URL=runtimeUrl;
}));

test('duplicados e colisões por caixa/espaço respondem 202 e não mutam nada',async()=>withDb(async({db})=>{
 await registration.registerParticipant(participantDto('Ana@Example.invalid'));
 const before=await snapshot(db);
 for(const email of ['ana@example.invalid','ANA@EXAMPLE.INVALID','  Ana@Example.invalid  ']){
  assert.deepEqual(await registration.registerParticipant(participantDto(email,{goal:'leadership',area:'produto',otherArea:undefined})),{status:'received',next:'check_email'});
  assert.deepEqual(await registration.registerMentor(mentorDto(email)),{status:'received',next:'check_email'});
 }
 assert.equal(same(await snapshot(db),before),true,'nenhuma linha mudou: sem papel novo, sem perfil de mentora, sem job, sem rotação');
 const concurrent=await Promise.all(Array.from({length:6},(_,i)=>registration.registerParticipant(participantDto(i%2?'Corrida@Example.invalid':'corrida@example.invalid '))));
 assert.equal(concurrent.every(r=>r.status==='received'),true);
 assert.deepEqual(await counts(db),{users:2,roles:2,participants:2,mentors:0,jobs:2});
}));

test('conta existente ativa ou privilegiada não recebe perfil, papel nem credencial por cadastro público',async()=>withDb(async({db})=>{
 const hash=await hashPassword(synthetic());
 const admin=randomUUID(),active=randomUUID();
 await db.query("insert into app_user(id,email,status,password_hash) values($1,'dona@example.invalid','active',$3),($2,'ativa@example.invalid','active',$3)",[admin,active,hash]);
 await db.query("insert into user_role(user_id,role) values($1,'admin'),($2,'participant')",[admin,active]);
 const before=await snapshot(db);
 for(const email of ['DONA@example.invalid','dona@example.invalid ','Ativa@Example.invalid']){
  assert.deepEqual(await registration.registerParticipant(participantDto(email)),{status:'received',next:'check_email'});
  assert.deepEqual(await registration.registerMentor(mentorDto(email)),{status:'received',next:'check_email'});
 }
 assert.equal(same(await snapshot(db),before),true);
}));

test('candidato de domínio legado sem user_id é protegido: cadastro público não cria usuário nem perfil paralelo',async()=>withDb(async({db})=>{
 await db.query(`insert into participant(id,email,goal,moment,interests,skills,token_hash,consent_version) values(7,'Legada@Example.invalid','growth','working','["dados"]','["analise"]','${'a'.repeat(64)}','v0')`);
 await db.query(`insert into mentor(id,email,trajectory,specialties,availability,capacity) values(9,'mentor.legada@example.invalid','t','["produto"]','a',2)`);
 const before=await snapshot(db);
 for(const email of ['legada@example.invalid','  LEGADA@example.invalid','Mentor.Legada@example.invalid']){
  assert.deepEqual(await registration.registerParticipant(participantDto(email)),{status:'received',next:'check_email'});
  assert.deepEqual(await registration.registerMentor(mentorDto(email)),{status:'received',next:'check_email'});
 }
 assert.equal(same(await snapshot(db),before),true);
}));

test('fronteira: runtime só executa os cadastros fechados; sem DML livre nem mapa privado; mailer não cadastra',async()=>withDb(async({db})=>{
 const as=async(role:string,sql:string,params:unknown[]=[])=>{const c=await db.connect();try{await c.query(`set role ${role}`);await c.query(sql,params);return true}catch{return false}finally{await c.query('reset role').catch(()=>undefined);c.release()}};
 for(const sql of ["insert into app_user(id,email,status) values(gen_random_uuid(),'x@example.invalid','active')","insert into user_role(user_id,role) values(gen_random_uuid(),'participant')","insert into email_job(id,user_id,kind,generation,status,dedupe_key) values(gen_random_uuid(),gen_random_uuid(),'registration',0,'queued','k')",'select * from migration_identity_link',"update participant set user_id=null","select internal.activate_legacy_identity(gen_random_uuid())"])
  assert.equal(await as('techwoman_runtime',sql),false,'runtime: '+sql);
 const fns=(await db.query("select p.proname,p.prosecdef,p.proconfig::text cfg,has_function_privilege('public',p.oid,'execute') pub,has_function_privilege('techwoman_runtime',p.oid,'execute') rt,has_function_privilege('techwoman_mailer',p.oid,'execute') ml from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='internal' and p.proname in ('register_participant_account','register_mentor_account','activate_legacy_identity')")).rows;
 assert.deepEqual(fns.map(f=>f.proname).sort(),['activate_legacy_identity','register_mentor_account','register_participant_account']);
 for(const f of fns){assert.equal(f.prosecdef,true,f.proname);assert.equal(/search_path=pg_catalog, pg_temp/.test(f.cfg),true,f.proname);assert.equal(f.pub,false,f.proname);assert.equal(f.ml,false,f.proname);assert.equal(f.rt,f.proname!=='activate_legacy_identity',f.proname);}
}));
