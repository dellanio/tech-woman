import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {migrate} from '../../scripts/migration/migrate';
import {closeDb,hashPassword,tokenDigest} from '../../src/lib/db';
import * as identity from '../../src/lib/identity';
import * as contracts from '../../src/lib/contracts';
import * as registration from '../../src/lib/registration';

const base=process.env.MIGRATION_DATABASE_URL;
type Ctx={db:Pool;url:string};
const synthetic=()=>`pw-${randomBytes(12).toString('base64url')}`;
const roleUrl=(url:string,role:string)=>{const u=new URL(url);u.searchParams.set('options',`-c role=${role} -c jit=off`);return u.toString();};

/** Banco isolado; o app roda de verdade como techwoman_runtime (SET ROLE na conexão), as fixtures como dono. */
async function withDb(fn:(ctx:Ctx)=>Promise<void>){
 assert.ok(base,'MIGRATION_DATABASE_URL');const control=new Pool({connectionString:base});const name='tw_reg_'+randomUUID().replace(/-/g,'');
 const created:string[]=[];
 for(const role of ['techwoman_runtime','techwoman_mailer']){ if(!(await control.query('select 1 from pg_roles where rolname=$1',[role])).rowCount){await control.query(`create role ${role} nologin`);created.push(role);} }
 await control.query(`create database ${name}`);const u=new URL(base);u.pathname='/'+name;const url=u.toString();
 const db=new Pool({connectionString:url,max:6,options:'-c jit=off'});const previous=process.env.DATABASE_URL;const deadline=process.env.MENTOR_DEADLINE;
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
 const m=(await db.query(`select m.user_id=u.id linked,m.email,m.display_name,m.trajectory,m.specialties,m.availability,m.capacity,m.active,m.demo,m.consent_version,m.consent_at is not null c,(select role from user_role r where r.user_id=u.id) role,u.status from mentor m join app_user u on u.id=m.user_id`)).rows[0];
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

async function addUser(db:Pool,opts:{email?:string;status?:string;password?:string;roles?:string[]}={}){
 const id=randomUUID(),email=opts.email??`u-${id.slice(0,8)}@example.invalid`;
 await db.query("insert into app_user(id,email,status,password_hash) values($1,$2,$3,$4)",[id,email,opts.status??'active',opts.password?await hashPassword(opts.password):null]);
 for(const role of opts.roles??['participant'])await db.query('insert into user_role(user_id,role) values($1,$2)',[id,role]);
 return {id,email};
}
const jobs=async(db:Pool,userId:string)=>(await db.query('select kind,status,generation::int g,dedupe_key,attempts,lease_owner is null lo from email_job where user_id=$1 order by created_at,id',[userId])).rows;
const userState=async(db:Pool,id:string)=>JSON.stringify((await db.query('select password_hash,temporary_password_hash,temporary_expires_at,temporary_used_at,credential_generation::text g,must_change_password,status,session_version::text sv,updated_at from app_user where id=$1',[id])).rows[0]);

test('esqueci a senha: conta ativa (inclusive admin) → job de reset; pendente → job temporário; nada mais; nunca revoga senha/sessão',async()=>withDb(async({db})=>{
 const pw=synthetic();
 const active=await addUser(db,{password:pw}),admin=await addUser(db,{password:pw,roles:['admin','mentor']}),pending=await addUser(db,{status:'pending_activation'});
 const privPending=await addUser(db,{status:'pending_activation',roles:['team']}),disabled=await addUser(db,{password:pw,status:'disabled'});
 const session=await identity.login(active.email,pw);assert.ok(session);
 const before=await userState(db,active.id);
 assert.deepEqual(await identity.requestPasswordForgot(`  ${active.email.toUpperCase()} `),{status:'received'});
 assert.equal(same(await userState(db,active.id),before),true,'forgot não toca hash, geração, sessão ou status');
 assert.ok(await identity.identitySession(session.token));assert.ok(await identity.login(active.email,pw));
 const a=await jobs(db,active.id);assert.deepEqual(a.map(j=>[j.kind,j.status,j.attempts,j.lo]),[['password_reset','queued',0,true]]);
 assert.equal(a[0].g,Number(JSON.parse(before).g));
 await Promise.all([1,2,3,4].map(()=>identity.requestPasswordForgot(active.email)));assert.equal((await jobs(db,active.id)).length,1,'job ativo deduplica corridas e repetições');
 await identity.requestPasswordForgot(admin.email);assert.deepEqual((await jobs(db,admin.id)).map(j=>j.kind),['password_reset'],'autoatendimento de admin com prova por e-mail');
 await identity.requestPasswordForgot(pending.email);await identity.requestPasswordForgot(pending.email);
 assert.deepEqual((await jobs(db,pending.id)).map(j=>[j.kind,j.status]),[['registration','queued']]);
 for(const email of [privPending.email,disabled.email,'ninguem@example.invalid'])assert.deepEqual(await identity.requestPasswordForgot(email),{status:'received'});
 assert.equal((await jobs(db,privPending.id)).length+(await jobs(db,disabled.id)).length,0,'privilegiado pendente e desativado nunca recebem emissão');
 assert.equal((await db.query('select count(*)::int n from email_job')).rows[0].n,3);
 await db.query("update email_job set status='accepted' where user_id=$1",[active.id]);await identity.requestPasswordForgot(active.email);
 assert.equal((await jobs(db,active.id)).length,2,'novo pedido após aceite gera nova intenção');
}));

test('reenvio administrativo de temporário: só não-admin/não-desativado, idempotente por chave, intenção distinta',async()=>withDb(async({db})=>{
 const pw=synthetic();const user=await addUser(db,{password:pw});const pending=await addUser(db,{status:'pending_activation'});
 const admin=await addUser(db,{password:pw,roles:['admin']}),team=await addUser(db,{password:pw,roles:['team']}),disabled=await addUser(db,{password:pw,status:'disabled'});
 const session=await identity.login(user.email,pw);assert.ok(session);const before=await userState(db,user.id);
 const [k1,k2]=[randomUUID(),randomUUID()];
 const first=await identity.enqueueAdminTemporaryPassword(user.id,k1);assert.ok(first);assert.equal(first.status,'queued');assert.match(first.jobId,/^[0-9a-f-]{36}$/);
 const again=await identity.enqueueAdminTemporaryPassword(user.id,k1);assert.deepEqual(again,first);assert.equal((await jobs(db,user.id)).length,1);
 const other=await identity.enqueueAdminTemporaryPassword(user.id,k2);assert.ok(other);assert.equal(other.jobId===first.jobId,false);
 assert.deepEqual((await jobs(db,user.id)).map(j=>j.kind),['temporary_password','temporary_password']);
 assert.equal(same(await userState(db,user.id),before),true,'enfileirar não emite nem revoga: a emissão é do worker');assert.ok(await identity.identitySession(session.token));
 assert.ok(await identity.enqueueAdminTemporaryPassword(pending.id,randomUUID()));
 for(const target of [admin.id,team.id,disabled.id,randomUUID()])assert.equal(await identity.enqueueAdminTemporaryPassword(target,randomUUID()),null);
 assert.equal((await jobs(db,admin.id)).length+(await jobs(db,team.id)).length+(await jobs(db,disabled.id)).length,0);
 await assert.rejects(()=>identity.enqueueAdminTemporaryPassword(user.id,'nao-e-uuid'),(e:unknown)=>e instanceof identity.IdentityError&&e.code==='INVALID_INPUT');
 const concurrent=await Promise.all([1,2,3].map(()=>identity.enqueueAdminTemporaryPassword(pending.id,k1)));assert.equal(new Set(concurrent.map(c=>c?.jobId)).size,concurrent[0]?1:0);
}));

test('perfil próprio: sessão full anexa participant/mentor só ao próprio usuário; admin 404; sem ligar por e-mail',async()=>withDb(async({db})=>{
 const pw=synthetic();const {goal,moment,interests,skills,area,otherArea,consent}=participantDto('x@example.invalid');
 const profile={goal,moment,interests,skills,area,otherArea,consent};const mentorProfile=(({email:_e,...rest})=>rest)(mentorDto('x@example.invalid'));
 const user=await addUser(db,{password:pw,roles:['participant']});await db.query("insert into participant(email,goal,moment,interests,skills,token_hash,consent_version,user_id) values($1,'growth','working','[]','[]',$2,'v1',$3)",[user.email,'b'.repeat(64),user.id]);
 const s=await identity.login(user.email,pw);assert.ok(s);
 assert.equal(await registration.addOwnProfile(s.token,'mentor',mentorProfile),'created');
 const m=(await db.query('select user_id,email,display_name,capacity,consent_version from mentor')).rows[0];assert.deepEqual([m.user_id,m.email,m.display_name,m.capacity,m.consent_version],[user.id,user.email,'Mentora Fictícia',3,'v1']);
 assert.deepEqual((await db.query('select role from user_role where user_id=$1 order by role',[user.id])).rows.map(r=>r.role),['mentor','participant']);
 assert.equal(await registration.addOwnProfile(s.token,'mentor',mentorProfile),'conflict');assert.equal(await registration.addOwnProfile(s.token,'participant',profile),'conflict');
 assert.equal((await db.query('select count(*)::int n from mentor')).rows[0].n,1);
 const mentorOnly=await addUser(db,{password:pw,roles:['mentor']});const s2=await identity.login(mentorOnly.email,pw);assert.ok(s2);
 assert.equal(await registration.addOwnProfile(s2.token,'participant',profile),'created');
 assert.deepEqual((await db.query('select user_id=$1 own,email from participant where user_id=$1',[mentorOnly.id])).rows,[{own:true,email:mentorOnly.email}]);
 const adminUser=await addUser(db,{password:pw,roles:['admin']});const teamUser=await addUser(db,{password:pw,roles:['team','participant']});
 const sa=await identity.login(adminUser.email,pw),st=await identity.login(teamUser.email,pw);assert.ok(sa&&st);
 const beforeAdmin=await snapshot(db);
 assert.equal(await registration.addOwnProfile(sa.token,'mentor',mentorProfile),'not_found');assert.equal(await registration.addOwnProfile(st.token,'mentor',mentorProfile),'not_found');
 assert.equal(same(await snapshot(db),beforeAdmin),true,'alvo privilegiado: nada muda');
 const temp=await addUser(db,{status:'pending_activation'});const t=identity.generateTemporaryPassword();await db.query('select internal.issue_temporary_credential($1::uuid,$2)',[temp.id,await hashPassword(t)]);
 const limited=await identity.login(temp.email,t);assert.ok(limited);assert.equal(await registration.addOwnProfile(limited.token,'participant',profile),'not_found','sessão limitada não anexa perfil');
 assert.equal(await registration.addOwnProfile(identity.newSessionToken(),'participant',profile),'not_found');assert.equal(await registration.addOwnProfile('lixo','participant',profile),'not_found');
 await db.query(`insert into participant(id,email,goal,moment,interests,skills,token_hash,consent_version) values(501,'Colisao@Example.invalid','growth','working','[]','[]','${'c'.repeat(64)}','v0')`);
 const clash=await addUser(db,{password:pw,email:'colisao@example.invalid',roles:['mentor']});const sc=await identity.login(clash.email,pw);assert.ok(sc);
 assert.equal(await registration.addOwnProfile(sc.token,'participant',profile),'reconciliation','não liga nem duplica registro legado por e-mail');
 assert.equal((await db.query('select user_id is null n from participant where id=501')).rows[0].n,true);
 await assert.rejects(()=>registration.addOwnProfile(s2.token,'participant',{...profile,email:'x@example.invalid',roles:['admin'],userId:'1'}),(e:unknown)=>e instanceof contracts.ContractError);
 process.env.MENTOR_DEADLINE='2020-01-01T00:00:00.000Z';await assert.rejects(()=>registration.addOwnProfile(s2.token,'mentor',mentorProfile),(e:unknown)=>e instanceof registration.RegistrationClosedError);
}));

async function legacyFixture(db:Pool){
 const run=randomUUID();await db.query("insert into migration_run(id,source_checksum,status) values($1,$2,'pending')",[run,run]);
 const link=(table:string,key:string,user:string|null,resolution:string)=>db.query('insert into migration_identity_link(run_id,source_table,source_key,user_id,resolution) values($1,$2,$3,$4,$5)',[run,table,key,user,resolution]);
 const participant=(id:number,email:string,userId:string|null=null)=>db.query("insert into participant(id,email,goal,moment,interests,skills,token_hash,consent_version,user_id) values($1,$2,'growth','working','[]','[]',$3,'v0',$4)",[id,email,String(id).padStart(64,'e'),userId]);
 const mentor=(id:number,email:string)=>db.query("insert into mentor(id,email,trajectory,specialties,availability,capacity) values($1,$2,'t','[]','a',2)",[id,email]);
 return {link,participant,mentor};
}
/** `direct` grava o temporário como dono do banco (fixture de conta privilegiada, que a função de emissão recusa). */
const temporaryLogin=async(db:Pool,userId:string,email:string,direct=false)=>{const t=identity.generateTemporaryPassword();
 if(direct)await db.query("update app_user set temporary_password_hash=$2,temporary_expires_at=now()+interval '24 hours',must_change_password=true,credential_generation=credential_generation+1 where id=$1",[userId,await hashPassword(t)]);
 else await db.query('select internal.issue_temporary_credential($1::uuid,$2)',[userId,await hashPassword(t)]);const s=await identity.login(email,t);assert.ok(s);return {temp:t,session:s};};

test('ativação legada: só a troca inicial comprovada liga perfis do mapa privado e revoga o token legado',async()=>withDb(async({db})=>{
 const {link,participant,mentor}=await legacyFixture(db);
 const user=await addUser(db,{email:'leg@example.invalid',status:'pending_activation',roles:[]});
 await participant(101,'Leg@Example.invalid ');await mentor(201,'LEG@example.invalid');
 await link('participant','101',user.id,'awaiting_email_proof');await link('mentor','201',user.id,'awaiting_email_proof');
 const tokenBefore=(await db.query('select token_hash from participant where id=101')).rows[0].token_hash;
 const {temp,session}=await temporaryLogin(db,user.id,user.email);
 assert.deepEqual((await db.query('select (select user_id from participant where id=101) p,(select user_id from mentor where id=201) m,(select count(*)::int from user_role) r')).rows[0],{p:null,m:null,r:0},'login com temporário ainda não liga nada');
 const guard0=(await db.query('select revision::int r from internal.agenda_guard')).rows[0].r;
 const first=synthetic();const done=await identity.changePassword(session.token,temp,first);
 const p=(await db.query('select user_id,legacy_access_revoked_at is not null revoked,token_hash=$1 same from participant where id=101',[tokenBefore])).rows[0];
 assert.deepEqual([p.user_id,p.revoked,p.same],[user.id,true,true],'FK ligada, acesso legado revogado, hash preservado para auditoria');
 assert.equal((await db.query('select user_id from mentor where id=201')).rows[0].user_id,user.id);
 assert.deepEqual((await db.query('select role from user_role where user_id=$1 order by role',[user.id])).rows.map(r=>r.role),['mentor','participant']);
 assert.deepEqual((await db.query('select source_table,resolution from migration_identity_link order by source_table')).rows,[{source_table:'mentor',resolution:'activated'},{source_table:'participant',resolution:'activated'}]);
 assert.equal((await db.query('select revision::int r from internal.agenda_guard')).rows[0].r>guard0,true,'escrita do guard de Agenda');
 await participant(106,'leg@example.invalid');await link('participant','106',user.id,'awaiting_email_proof');
 await identity.changePassword(done.token,first,synthetic());
 assert.equal((await db.query('select user_id is null n from participant where id=106')).rows[0].n,true,'troca por sessão full nunca ativa mapa novo');
}));

test('ativação legada recusa ambiguidade, candidato privilegiado, e-mail divergente e perfil já existente, sem quebrar a troca',async()=>withDb(async({db})=>{
 const {link,participant,mentor}=await legacyFixture(db);
 // ambíguo: outro registro legado sem user_id com a mesma chave fora do mapa do usuário
 const amb=await addUser(db,{email:'amb@example.invalid',status:'pending_activation',roles:[]});
 await participant(111,'amb@example.invalid');await participant(112,'AMB@example.invalid');await mentor(211,'amb@example.invalid');
 await link('participant','111',amb.id,'awaiting_email_proof');await link('mentor','211',amb.id,'awaiting_email_proof');
 // privilegiado: usuário team/admin com mapa awaiting (nunca vinculado) e candidato sem user_id
 const priv=await addUser(db,{email:'priv@example.invalid',status:'pending_activation',roles:['team']});
 await participant(121,'priv@example.invalid');await link('participant','121',priv.id,'awaiting_email_proof');
 await participant(122,'Dona@Example.invalid');await link('participant','122',null,'privileged_candidate');
 const admin=await addUser(db,{email:'dona@example.invalid',password:synthetic(),roles:['admin']});
 // e-mail divergente da chave do usuário
 const mis=await addUser(db,{email:'mis@example.invalid',status:'pending_activation',roles:[]});
 await participant(131,'outra.pessoa@example.invalid');await link('participant','131',mis.id,'awaiting_email_proof');
 // usuário que já tem perfil de participante próprio
 const own=await addUser(db,{email:'own@example.invalid',status:'pending_activation',roles:['participant']});
 await participant(141,'own@example.invalid',own.id);await participant(142,'own@example.invalid');await mentor(241,'own@example.invalid');
 await link('participant','142',own.id,'awaiting_email_proof');await link('mentor','241',own.id,'awaiting_email_proof');
 for(const u of [amb,priv,mis,own]){const {temp,session}=await temporaryLogin(db,u.id,u.email,u===priv);await identity.changePassword(session.token,temp,synthetic());}
 const rows=(await db.query('select id::int,user_id,legacy_access_revoked_at is not null revoked from participant order by id')).rows;
 const linked=Object.fromEntries(rows.map(r=>[r.id,r.user_id]));
 assert.deepEqual([linked[111],linked[112],linked[121],linked[122],linked[131],linked[142]],[null,null,null,null,null,null],'nenhum registro ambíguo, privilegiado, divergente ou duplicado é ligado');
 assert.equal(rows.filter(r=>r.id!==141).some(r=>r.revoked),false,'nenhum token legado revogado');assert.equal(linked[141],own.id);
 assert.deepEqual([(await db.query('select user_id from mentor where id=211')).rows[0].user_id,(await db.query('select user_id from mentor where id=241')).rows[0].user_id],[amb.id,own.id],'domínio sem ambiguidade na própria tabela continua ligado');
 assert.deepEqual((await db.query("select role from user_role where user_id=$1",[priv.id])).rows.map(r=>r.role),['team'],'sem papel novo para privilegiado');
 assert.deepEqual((await db.query("select role from user_role where user_id=$1",[admin.id])).rows.map(r=>r.role),['admin']);
 assert.equal((await db.query("select count(*)::int n from migration_identity_link where resolution='awaiting_email_proof'")).rows[0].n,4,'mapa não resolvido segue preservado');
}));
