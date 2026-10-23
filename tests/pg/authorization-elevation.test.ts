/**
 * R3 × elevação offline nas operações v1 (correção final I1/M1): linhas de domínio com user_id NULL e o MESMO e-mail da conta elevada
 * (sem vínculo, sem posse inferida) ficam protegidas no commit da elevação. A escrita concorrente precisa esperar o lock dessa conta
 * (conjunto ator + contas por user_id OU e-mail, FOR NO KEY UPDATE em ordem de UUID) e, depois do commit, responder como protegido, sem mutação.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import * as participantOne from '../../src/app/api/v1/admin/participants/[id]/route';
import * as mentorOne from '../../src/app/api/v1/admin/mentors/[id]/route';
import * as matches from '../../src/app/api/v1/admin/matches/route';
import * as matchOne from '../../src/app/api/v1/admin/matches/[id]/route';
import * as mentorTopics from '../../src/app/api/v1/mentors/[mentorId]/topics/route';
import * as cohortOne from '../../src/app/api/v1/cohorts/[id]/route';
import * as adminEnrollment from '../../src/app/api/v1/admin/enrollments/[id]/route';
import * as reassign from '../../src/app/api/v1/admin/enrollments/[id]/reassign/route';
import {runPrivilegedAccount} from '../../scripts/privileged-account';
import {withDb,addParticipant,addMentor,addTopic,addMentorTopic,addCohort,mentorWithCohort} from './agenda-harness';
import {actorOf,as,code,etagOf,snapshot,type Actor,type Reply} from './agenda-api-kit';

const P='/api/v1/admin/participants',M='/api/v1/admin/mentors',X='/api/v1/admin/matches',E='/api/v1/admin/enrollments';
const lockWaiters=async(db:Pool)=>(await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and state='active' and wait_event_type='Lock'")).rows[0].n as number;
/** Barreira real: espera n backends bloqueados em lock (ou as requisições terminarem sem bloquear, o que o teste reprova depois). */
async function untilBlocked(db:Pool,pending:Promise<unknown>,n:number){
 let done=false;pending.then(()=>{done=true;},()=>{done=true;});
 for(let i=0;i<200&&!done;i++){if(await lockWaiters(db)>=n)return true;await new Promise(r=>setTimeout(r,25));}
 return false;
}
/** Conta comum ativa (sem vínculo de domínio) cujo e-mail coincide com linhas de domínio legadas user_id NULL. */
async function nullCandidates(db:Pool){
 const target=await actorOf(db,['participant'],{email:'alvo@example.invalid'});
 const participant=await addParticipant(db,{userId:null,email:' ALVO@example.invalid'});
 const mentor=await addMentor(db,{userId:null,email:'Alvo@Example.invalid',specialties:['dados']});
 const mentorTopic=await addMentorTopic(db,mentor,await addTopic(db));const cohort=await addCohort(db,mentorTopic,{from:40,capacity:3});
 return {target,participant,mentor,mentorTopic,cohort};
}
/** Executa as escritas DURANTE a elevação (lock da conta já tomado pelo script) e devolve as respostas e se elas esperaram o lock. */
async function duringElevation(db:Pool,url:string,target:Actor,n:number,requests:()=>Promise<Reply>[]){
 let pending:Promise<Reply[]>=Promise.resolve([]);let waited=false;
 const elevated=await runPrivilegedAccount(['grant-admin','--user-id',target.id,'--confirm'],{MIGRATION_DATABASE_URL:url},{afterLock:async()=>{
  pending=Promise.all(requests());waited=await untilBlocked(db,pending,n);
 }});
 assert.deepEqual(elevated,{code:'ok'});
 return {replies:await pending,waited};
}
const outcome=(r:Reply)=>[r.status,code(r),r.json?.error?.fields??[]];
const domainState=(s:string)=>{const v=JSON.parse(s);return {participants:v.participants,mentors:v.mentors,links:v.links,cohorts:v.cohorts,enrollments:v.enrollments,matches:v.matches,jobs:v.jobs,idem:v.idem};};

test('I1 elevação × CRUD de participante/mentora com candidato NULL de mesmo e-mail: PATCH/DELETE esperam o lock da conta e viram 404 sem mutação',()=>withDb(async({db,url})=>{
 const admin=await actorOf(db,['admin']);const A=as(admin);const c=await nullCandidates(db);
 const pv=etagOf(await A.get(participantOne.GET,`${P}/${c.participant}`,{id:c.participant})),mv=etagOf(await A.get(mentorOne.GET,`${M}/${c.mentor}`,{id:c.mentor}));
 const before=await snapshot(db);
 const {replies,waited}=await duringElevation(db,url,c.target,3,()=>[
  A.send(participantOne.PATCH,`${P}/${c.participant}`,{method:'PATCH',body:{goal:'leadership'},params:{id:c.participant},version:pv}),
  A.send(mentorOne.PATCH,`${M}/${c.mentor}`,{method:'PATCH',body:{displayName:'Outra'},params:{id:c.mentor},version:mv}),
  A.send(mentorOne.DELETE,`${M}/${c.mentor}`,{method:'DELETE',params:{id:c.mentor},version:mv})]);
 assert.deepEqual(replies.map(outcome),[[404,'NOT_FOUND',[]],[404,'NOT_FOUND',[]],[404,'NOT_FOUND',[]]]);
 assert.equal(waited,true,'as escritas esperaram o lock da conta de mesmo e-mail');
 const after=await snapshot(db);assert.deepEqual(domainState(after),domainState(before),'nenhuma mutação de domínio');
 assert.equal(JSON.parse(after).audits,JSON.parse(before).audits+1,'só a auditoria da elevação');
}));

test('I1 elevação × temas/turmas da mentora e matches com candidato NULL: escritas esperam o lock e respondem como protegido (404 / 422 por campo) sem mutação',()=>withDb(async({db,url})=>{
 const admin=await actorOf(db,['admin']);const A=as(admin);const c=await nullCandidates(db);
 const common=await addParticipant(db,{interests:['dados']});const other=await addMentor(db,{specialties:['dados']});const extraTopic=await addTopic(db);
 const pair=(await db.query("insert into match(participant_id,mentor_id,score,reasons,status,origin) values($1,$2,1,'[]','suggested','current') returning id::text id",[c.participant,other])).rows[0].id;
 const cv=etagOf(await A.get(cohortOne.GET,`/api/v1/cohorts/${c.cohort}`,{id:c.cohort})),xv=etagOf(await A.get(matchOne.GET,`${X}/${pair}`,{id:pair}));
 const before=await snapshot(db);
 const {replies,waited}=await duringElevation(db,url,c.target,4,()=>[
  A.send(mentorTopics.POST,`/api/v1/mentors/${c.mentor}/topics`,{body:{topicId:extraTopic,position:2},params:{mentorId:c.mentor},key:randomUUID()}),
  A.send(cohortOne.PATCH,`/api/v1/cohorts/${c.cohort}`,{method:'PATCH',body:{capacity:6},params:{id:c.cohort},version:cv}),
  A.send(matches.POST,X,{body:{participantId:common,mentorId:c.mentor},key:randomUUID()}),
  A.send(matchOne.PATCH,`${X}/${pair}`,{method:'PATCH',body:{status:'rejected'},params:{id:pair},version:xv})]);
 assert.deepEqual(replies.map(outcome),[[404,'NOT_FOUND',[]],[404,'NOT_FOUND',[]],[422,'INVALID_INPUT',['mentorId']],[404,'NOT_FOUND',[]]]);
 assert.equal(waited,true,'as escritas esperaram o lock da conta de mesmo e-mail');
 const after=await snapshot(db);assert.deepEqual(domainState(after),domainState(before),'nenhuma mutação de agenda/match');
 assert.equal(JSON.parse(after).audits,JSON.parse(before).audits+1);
}));

test('I1/M1 elevação × inscrições: cancelar reserva em turma da mentora candidata e realocar para ela esperam o lock (404 / 422 cohortId); replay de realocação para destino que virou protegido → 404 sem mutação',()=>withDb(async({db,url})=>{
 const admin=await actorOf(db,['admin']);const A=as(admin);const c=await nullCandidates(db);
 const free=await mentorWithCohort(db,{from:10,capacity:5});
 const enroll=async(cohort:string)=>{const p=await addParticipant(db);return (await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id::text id",[p,cohort])).rows[0].id as string;};
 const inCandidate=await enroll(c.cohort),toMove=await enroll(free.cohort),moved=await enroll(free.cohort);
 // M1: realocação concluída ANTES da elevação, para a turma da mentora candidata (ainda comum)
 const key=randomUUID();const body={cohortId:c.cohort,confirm:true};
 let r=await A.send(reassign.POST,`${E}/${moved}/reassign`,{body,params:{id:moved},key});assert.equal(r.status,201);const destination=r.json.data.id;
 const ev=etagOf(await A.get(adminEnrollment.GET,`${E}/${inCandidate}`,{id:inCandidate}));
 const before=await snapshot(db);
 const {replies,waited}=await duringElevation(db,url,c.target,2,()=>[
  A.send(adminEnrollment.DELETE,`${E}/${inCandidate}`,{method:'DELETE',params:{id:inCandidate},version:ev}),
  A.send(reassign.POST,`${E}/${toMove}/reassign`,{body:{cohortId:c.cohort,confirm:true},params:{id:toMove},key:randomUUID()})]);
 assert.deepEqual(replies.map(outcome),[[404,'NOT_FOUND',[]],[422,'INVALID_INPUT',['cohortId']]]);
 assert.equal(waited,true,'as escritas esperaram o lock da conta da mentora da turma');
 r=await A.send(reassign.POST,`${E}/${moved}/reassign`,{body,params:{id:moved},key});
 assert.deepEqual(outcome(r),[404,'NOT_FOUND',[]],`replay não devolve a inscrição ${destination} cuja mentora de destino virou protegida`);
 const after=await snapshot(db);assert.deepEqual(domainState(after),domainState(before),'nenhuma mutação de inscrição/match/job');
 assert.equal(JSON.parse(after).audits,JSON.parse(before).audits+1);
}));
