import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import * as participants from '../../src/app/api/v1/admin/participants/route';
import * as participantOne from '../../src/app/api/v1/admin/participants/[id]/route';
import * as mentors from '../../src/app/api/v1/admin/mentors/route';
import * as mentorOne from '../../src/app/api/v1/admin/mentors/[id]/route';
import {runPrivilegedAccount} from '../../scripts/privileged-account';
import {withDb,withClients,addParticipant,addMentor,linkFixture,mentorWithCohort,pidOf,waitLocked} from './agenda-harness';
import {actorOf,as,code,etagOf,sameShape,snapshot,type Actor,type Reply} from './agenda-api-kit';

const P='/api/v1/admin/participants',M='/api/v1/admin/mentors';
const profile={goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true};
const mentorProfile={displayName:'Mentora Fictícia',trajectory:'Trajetória de teste',specialties:['produto'],availability:'Quartas',legacyCapacity:3,consent:true};
const ids=(r:Reply)=>r.json.data.map((x:{id:string})=>x.id);
const pGet=(a:Actor,id:string)=>as(a).get(participantOne.GET,`${P}/${id}`,{id});
const pPatch=(a:Actor,id:string,body:unknown,version?:string)=>as(a).send(participantOne.PATCH,`${P}/${id}`,{method:'PATCH',body,params:{id},version});
const pDel=(a:Actor,id:string,version?:string)=>as(a).send(participantOne.DELETE,`${P}/${id}`,{method:'DELETE',params:{id},version});

/** Domínios protegidos: admin multi-perfil vinculado, mentora/participante com e-mail de admin (sem vínculo) e candidato privilegiado com user_id NULL. */
async function protectedFixtures(db:Pool){
 const {link}=await linkFixture(db);
 const multi=await actorOf(db,['admin','participant','mentor'],{email:'multi@example.invalid'});
 const pAdmin=await addParticipant(db,{userId:multi.id,email:'multi@example.invalid'});const mAdmin=await addMentor(db,{userId:multi.id,email:'multi@example.invalid'});
 const pSameEmail=await addParticipant(db,{userId:null,email:'MULTI@example.invalid'});
 const pCandidate=await addParticipant(db,{userId:null,email:'candidata@example.invalid'});await link('participant',pCandidate,null,'privileged_candidate');
 const mCandidate=await addMentor(db,{email:'cand-m@example.invalid'});await link('mentor',mCandidate,null,'privileged_candidate');
 return {participants:[pAdmin,pSameEmail,pCandidate],mentors:[mAdmin,mCandidate]};
}

test('admin participants: conta+domínio numa transação (idempotente, e-mail indisponível genérico sem órfão), DTO fechado sem mass assignment, protegidos (vinculado, e-mail de admin, candidato NULL) omitidos/404, team só lê, If-Match, soft delete com reserva 409',()=>withDb(async({db})=>{
 const admin=await actorOf(db,['admin']),team=await actorOf(db,['team']),plain=await actorOf(db,['participant']),mentorUser=await actorOf(db,['mentor']);
 const hidden=await protectedFixtures(db);const common=await addParticipant(db,{email:'comum@example.invalid',area:'outra: Saúde'});
 const A=as(admin);const key=randomUUID();const body={email:'Nova@Example.invalid',...profile};
 let r=await A.send(participants.POST,P,{body,key});
 assert.equal(r.status,201);assert.equal(etagOf(r),r.json.data.version);
 assert.deepEqual(Object.keys(r.json.data).sort(),['active','area','email','goal','id','interests','moment','skills','userId','version']);
 const created=r.json.data;assert.deepEqual([created.email,created.goal,created.area,created.active],['Nova@Example.invalid','growth','dados',true]);
 const account=(await db.query("select u.status,array_agg(r.role) roles,(select count(*)::int from email_job j where j.user_id=u.id and j.kind='registration' and j.status='queued') jobs from app_user u join user_role r on r.user_id=u.id where u.id=$1 group by u.id",[created.userId])).rows[0];
 assert.deepEqual(account,{status:'pending_activation',roles:['participant'],jobs:1},'conta pendente + papel + job de ativação, sem senha');
 r=await A.send(participants.POST,P,{body,key});assert.deepEqual([r.status,r.json.data.id],[201,created.id],'replay');
 r=await A.send(participants.POST,P,{body:{...body,goal:'leadership'},key});assert.deepEqual([r.status,code(r)],[409,'IDEMPOTENCY_CONFLICT']);
 const users=(await db.query('select count(*)::int n from app_user')).rows[0].n;
 const clashes=[];for(const email of ['nova@example.invalid','multi@example.invalid','candidata@example.invalid','comum@example.invalid'])clashes.push(await A.send(participants.POST,P,{body:{...body,email},key:randomUUID()}));
 for(const c of clashes){assert.deepEqual([c.status,code(c)],[409,'EMAIL_UNAVAILABLE']);assert.equal(sameShape(c,clashes[0]),true);}
 assert.equal((await db.query('select count(*)::int n from app_user')).rows[0].n,users,'sem usuário órfão');
 for(const bad of [{...body,userId:randomUUID()},{...body,consent:false},{...body,active:false},{...body,roles:['admin']},{...body,token:'x'},{...profile},[body]]){
  r=await A.send(participants.POST,P,{body:bad,key:randomUUID()});assert.deepEqual([JSON.stringify(Object.keys(bad)),r.status,code(r)],[JSON.stringify(Object.keys(bad)),422,'INVALID_INPUT']);
 }
 // leitura: protegidos fora da coleção e 404 idêntico ao inexistente
 for(const who of [admin,team]){r=await as(who).get(participants.GET,P);assert.deepEqual(ids(r),[common,created.id]);}
 r=await A.get(participants.GET,`${P}?limit=1`);assert.deepEqual(ids(r),[common]);r=await A.get(participants.GET,`${P}?limit=1&cursor=${r.json.page.nextCursor}`);assert.deepEqual([ids(r),r.json.page.nextCursor],[[created.id],null]);
 r=await pGet(team,common);assert.deepEqual([r.status,r.json.data.area,r.json.data.otherArea],[200,'outra','Saúde']);
 const probes=[...hidden.participants.map(id=>pGet(admin,id)),pGet(admin,'999999'),pGet(admin,'abc'),pGet(plain,common),pGet(mentorUser,common)];
 const results=await Promise.all(probes);for(const h of results){assert.deepEqual([h.status,code(h)],[404,'NOT_FOUND']);assert.equal(sameShape(h,results[0]),true);assert.equal(h.headers.get('etag'),null);}
 r=await as(plain).get(participants.GET,P);assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 // escrita: protegidos/inexistentes 404 sem mutação; team 403; mass assignment 422
 const before=await snapshot(db);
 for(const id of [...hidden.participants,'999999']){for(const h of [await pPatch(admin,id,{goal:'leadership'},'1'),await pDel(admin,id,'1')])assert.deepEqual([id,h.status,code(h)],[id,404,'NOT_FOUND']);}
 for(const h of [await pPatch(team,common,{goal:'leadership'},'1'),await pDel(team,common,'1'),await as(team).send(participants.POST,P,{body:{...body,email:'t@example.invalid'},key:randomUUID()})])assert.deepEqual([h.status,code(h)],[403,'FORBIDDEN']);
 const v=etagOf(await pGet(admin,common));
 for(const bad of [{email:'x@example.invalid'},{userId:randomUUID()},{consent:true},{consentVersion:'v9'},{token_hash:'x'},{id:'7'},{otherArea:'x'},{area:'outra'},{interests:['dados','dados']},{}]){
  r=await pPatch(admin,common,bad,v);assert.deepEqual([JSON.stringify(bad),r.status,code(r)],[JSON.stringify(bad),422,'INVALID_INPUT']);
 }
 r=await pPatch(admin,common,{goal:'leadership'});assert.deepEqual([r.status,code(r)],[428,'PRECONDITION_REQUIRED']);
 assert.equal(await snapshot(db),before,'recusas sem mutação');
 r=await pPatch(admin,common,{goal:'leadership',interests:['design','dados'],area:'design'},v);
 assert.equal(r.status,200);assert.deepEqual([r.json.data.goal,r.json.data.interests,r.json.data.area,r.json.data.otherArea],['leadership',['design','dados'],'design',undefined]);
 assert.equal((await db.query('select email,token_hash=$2 same from participant where id=$1',[common,(await db.query('select token_hash from participant where id=$1',[common])).rows[0].token_hash])).rows[0].email,'comum@example.invalid');
 r=await pPatch(admin,common,{goal:'growth'},v);assert.deepEqual([r.status,code(r)],[412,'VERSION_MISMATCH']);
 // soft delete: reserva ativa exige cancelamento explícito
 const agenda=await mentorWithCohort(db);await db.query("update app_user set status='active' where id=$1",[created.userId]);
 await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[created.id,agenda.cohort]);
 r=await pDel(admin,created.id,etagOf(await pGet(admin,created.id)));assert.deepEqual([r.status,code(r)],[409,'COHORT_IN_USE']);
 r=await pDel(admin,common,etagOf(await pGet(admin,common)));assert.deepEqual([r.status,r.json.data.active],[200,false]);
 assert.equal((await db.query('select count(*)::int n from participant where id=$1',[common])).rows[0].n,1,'histórico preservado');
 const audit=(await db.query("select actor_user_id,action,changed_fields from audit_event where entity_type='participant' order by id")).rows;
 assert.deepEqual(audit.map(a=>[a.actor_user_id,a.action]),[[admin.id,'participant.create'],[admin.id,'participant.update'],[admin.id,'participant.deactivate']]);
 assert.deepEqual(audit[1].changed_fields,['goal','interests','area']);assert.equal(JSON.stringify(audit).includes('@'),false);
}));

test('admin mentors: conta+domínio, projeção admin sem flag demo editável, protegidos 404, PATCH fechado/If-Match, soft delete com reserva 409',()=>withDb(async({db})=>{
 const admin=await actorOf(db,['admin']),team=await actorOf(db,['team']);const hidden=await protectedFixtures(db);const A=as(admin);
 const common=await addMentor(db,{email:'m-comum@example.invalid',specialties:['dados']});
 let r=await A.send(mentors.POST,M,{body:{email:'mentora.nova@example.invalid',...mentorProfile},key:randomUUID()});
 assert.equal(r.status,201);assert.deepEqual(Object.keys(r.json.data).sort(),['active','availability','demo','displayName','email','id','legacyCapacity','specialties','trajectory','userId','version']);
 const created=r.json.data;assert.deepEqual([created.displayName,created.legacyCapacity,created.demo],['Mentora Fictícia',3,false]);
 assert.deepEqual((await db.query("select array_agg(role) r from user_role where user_id=$1",[created.userId])).rows[0].r,['mentor']);
 for(const bad of [{email:'z@example.invalid',...mentorProfile,demo:true},{email:'z@example.invalid',...mentorProfile,capacity:3},{email:'z@example.invalid',...mentorProfile,legacyCapacity:51}]){r=await A.send(mentors.POST,M,{body:bad,key:randomUUID()});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);}
 r=await A.send(mentors.POST,M,{body:{email:'MULTI@example.invalid',...mentorProfile},key:randomUUID()});assert.deepEqual([r.status,code(r)],[409,'EMAIL_UNAVAILABLE']);
 r=await as(team).get(mentors.GET,M);assert.deepEqual(ids(r),[common,created.id]);
 for(const id of hidden.mentors){for(const h of [await A.get(mentorOne.GET,`${M}/${id}`,{id}),await A.send(mentorOne.PATCH,`${M}/${id}`,{method:'PATCH',body:{active:false},params:{id},version:'1'}),await A.send(mentorOne.DELETE,`${M}/${id}`,{method:'DELETE',params:{id},version:'1'})])assert.deepEqual([h.status,code(h)],[404,'NOT_FOUND']);}
 const v=etagOf(await A.get(mentorOne.GET,`${M}/${common}`,{id:common}));
 for(const bad of [{demo:true},{email:'x@example.invalid'},{userId:randomUUID()},{capacity:2},{legacyCapacity:0},{consentVersion:'x'}]){r=await A.send(mentorOne.PATCH,`${M}/${common}`,{method:'PATCH',body:bad,params:{id:common},version:v});assert.deepEqual([JSON.stringify(bad),r.status,code(r)],[JSON.stringify(bad),422,'INVALID_INPUT']);}
 r=await A.send(mentorOne.PATCH,`${M}/${common}`,{method:'PATCH',body:{displayName:'Nome Novo',legacyCapacity:30,specialties:['design']},params:{id:common},version:v});
 assert.equal(r.status,200);assert.deepEqual([r.json.data.displayName,r.json.data.legacyCapacity,r.json.data.specialties],['Nome Novo',30,['design']]);
 const agenda=await mentorWithCohort(db);await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[await addParticipant(db),agenda.cohort]);
 r=await A.send(mentorOne.DELETE,`${M}/${agenda.mentor}`,{method:'DELETE',params:{id:agenda.mentor},version:etagOf(await A.get(mentorOne.GET,`${M}/${agenda.mentor}`,{id:agenda.mentor}))});assert.deepEqual([r.status,code(r)],[409,'COHORT_IN_USE']);
 r=await A.send(mentorOne.DELETE,`${M}/${common}`,{method:'DELETE',params:{id:common},version:r.json?.data?.version??etagOf(await A.get(mentorOne.GET,`${M}/${common}`,{id:common}))});assert.deepEqual([r.status,r.json.data.active],[200,false]);
 r=await as(team).send(mentorOne.PATCH,`${M}/${common}`,{method:'PATCH',body:{active:true},params:{id:common},version:'9'});assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
}));

test('corrida elevação × CRUD de domínio: PATCH/DELETE de participante e mentora esperam o lock da conta e viram 404 sem mutação',()=>withDb(async({db,url})=>{
 const admin=await actorOf(db,['admin']);const target=await actorOf(db,['participant','mentor'],{email:'alvo@example.invalid'});
 const pid=await addParticipant(db,{userId:target.id,email:'alvo@example.invalid'});const mid=await addMentor(db,{userId:target.id,email:'alvo@example.invalid'});
 const pv=etagOf(await pGet(admin,pid)),mv=etagOf(await as(admin).get(mentorOne.GET,`${M}/${mid}`,{id:mid}));
 const before=JSON.parse(await snapshot(db));
 const blocked=async(n:number)=>{for(let i=0;i<200;i++){const c=(await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and state='active' and wait_event_type='Lock'")).rows[0].n;if(c>=n)return;await new Promise(r=>setTimeout(r,25));}throw new Error('operações não bloquearam');};
 let pending:Promise<Reply[]>=Promise.resolve([]);
 const elevated=await runPrivilegedAccount(['grant-admin','--user-id',target.id,'--confirm'],{MIGRATION_DATABASE_URL:url},{afterLock:async()=>{
  pending=Promise.all([pPatch(admin,pid,{goal:'leadership'},pv),pDel(admin,pid,pv),as(admin).send(mentorOne.PATCH,`${M}/${mid}`,{method:'PATCH',body:{displayName:'X'},params:{id:mid},version:mv})]);await blocked(3);
 }});
 assert.deepEqual(elevated,{code:'ok'});
 for(const r of await pending)assert.deepEqual([r.status,code(r)],[404,'NOT_FOUND']);
 const after=JSON.parse(await snapshot(db));assert.deepEqual([after.participants,after.mentors,after.idem],[before.participants,before.mentors,before.idem]);
 assert.equal(after.audits,before.audits+1,'só a auditoria da elevação');
}));

test('ator desativado enquanto espera o lock da própria conta: a escrita revalida sob lock e responde 401 sem mutação',()=>withDb(async({db,url})=>{
 const admin=await actorOf(db,['admin']);const pid=await addParticipant(db,{email:'p@example.invalid'});const v=etagOf(await pGet(admin,pid));
 const before=await snapshot(db);
 await withClients(url,[undefined],async c=>{
  await c.query('begin');await c.query('select 1 from app_user where id=$1 for update',[admin.id]);
  const pending=pPatch(admin,pid,{goal:'leadership'},v);
  const blockedPid=async()=>{for(let i=0;i<200;i++){const r=await db.query("select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>$1",[await pidOf(c)]);if(r.rowCount)return r.rows[0].pid as number;await new Promise(r=>setTimeout(r,25));}throw new Error('não bloqueou');};
  await waitLocked(db,await blockedPid());
  await c.query("update app_user set status='disabled',session_version=session_version+1 where id=$1",[admin.id]);await c.query('commit');
  const r=await pending;assert.deepEqual([r.status,code(r)],[401,'AUTH_REQUIRED']);
 });
 assert.equal(await snapshot(db),before,'domínio intacto');
}));
