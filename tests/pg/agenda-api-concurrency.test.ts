/**
 * Concorrência REAL API × SQL direto (correção final I5): handlers HTTP/runtime de verdade (internal.api_*) contra uma segunda conexão de SQL
 * direto, com barreira por pg_stat_activity (backend comprovadamente bloqueado em lock), sem mutex JS nem espera arbitrária.
 * D-048: a editora (pgAdmin) é somente leitura e recebe 42501 sem tocar o guard; o SQL direto concorrente é do dono do banco/operador (DIRECT_SQL).
 * READ COMMITTED: quem espera o guard revalida depois do commit do outro. REPEATABLE READ (pgAdmin): snapshot antigo → 40001 e retry integral.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import type {Client,Pool} from 'pg';
import * as enrollments from '../../src/app/api/v1/me/enrollments/route';
import * as reassign from '../../src/app/api/v1/admin/enrollments/[id]/reassign/route';
import {tokenDigest} from '../../src/lib/db';
import {withDb,withClients,addParticipant,mentorWithCohort,pgFails,pidOf,waitLocked,DIRECT_SQL,editorWriteDenied} from './agenda-harness';
import {actorOf,participantActor,as,code,type Reply} from './agenda-api-kit';

const ME='/api/v1/me/enrollments';
const enrollSql="insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id::text id";
const counts=async(db:Pool,cohort:string)=>(await db.query(`select (select count(*)::int from enrollment where cohort_id=$1 and status='active') active,
  (select count(*)::int from match m join enrollment e on e.id=m.enrollment_id where e.cohort_id=$1 and m.status='selected') matches,
  (select count(*)::int from email_job j join enrollment e on e.id=j.enrollment_id where e.cohort_id=$1 and j.kind='reservation' and j.status='queued') jobs`,[cohort])).rows[0];
/** Backend (≠ holder) bloqueado em lock nesta base: a requisição HTTP comprovadamente esperando o guard. */
async function blockedBackend(db:Pool,holder:Client){
 const own=await pidOf(holder);
 for(let i=0;i<200;i++){
  const r=await db.query("select pid from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and pid<>$1",[own]);
  if(r.rowCount){await waitLocked(db,r.rows[0].pid);return r.rows[0].pid as number;}
  await new Promise(r=>setTimeout(r,25));
 }
 throw new Error('a requisição não bloqueou no guard');
}
/** O SQL direto segura o guard (statement já executado, transação aberta); a requisição HTTP espera de verdade; o SQL direto confirma. */
async function directFirst(db:Pool,direct:Client,sql:string,args:unknown[],request:()=>Promise<Reply>){
 await direct.query('begin');await direct.query(sql,args);
 const pending=request();pending.catch(()=>undefined);
 await blockedBackend(db,direct);await direct.query('commit');
 return pending;
}

test('I5 última vaga: SQL direto do dono segura o guard inserindo a última vaga → POST /me/enrollments espera → após o commit 409 COHORT_FULL; 1 inscrição/1 match/1 job; editora negada sem tocar o guard',()=>withDb(async({db,url})=>{
 const agenda=await mentorWithCohort(db,{capacity:1,from:20});const p=await participantActor(db);const other=await addParticipant(db);
 await withClients(url,[DIRECT_SQL],async direct=>{
  const r=await directFirst(db,direct,enrollSql,[other,agenda.cohort],()=>as(p).send(enrollments.POST,ME,{body:{cohortId:agenda.cohort},key:randomUUID()}));
  assert.deepEqual([r.status,code(r)],[409,'COHORT_FULL']);
 });
 await editorWriteDenied(url,enrollSql,[other,agenda.cohort]);
 assert.deepEqual(await counts(db,agenda.cohort),{active:1,matches:1,jobs:1});
 assert.equal((await db.query("select count(*)::int n from api_idempotency where path=$1",[ME])).rows[0].n,0,'recusa desfaz a idempotência');
 assert.equal((await db.query("select count(*)::int n from enrollment where participant_id=$1",[p.participantId])).rows[0].n,0);
}));

test('I5 inverso: a API segura o guard numa transação explícita (internal.api_enroll como runtime) → INSERT direto do dono espera → após o commit agenda_capacity_exceeded; 1/1/1 com ator confiável',()=>withDb(async({db,url})=>{
 const agenda=await mentorWithCohort(db,{capacity:1,from:20});const p=await participantActor(db);const other=await addParticipant(db);
 await withClients(url,['techwoman_runtime',DIRECT_SQL],async (runtime,direct)=>{
  await runtime.query('begin');
  const made=(await runtime.query('select internal.api_enroll($1,$2,$3,$4,$5) r',[tokenDigest(p.token),randomUUID(),randomUUID(),createHash('sha256').update('i5').digest('hex'),{cohortId:agenda.cohort}])).rows[0].r;
  assert.equal(made.status,'active');
  const pid=await pidOf(direct);const pending=direct.query(enrollSql,[other,agenda.cohort]);pending.catch(()=>undefined);
  await waitLocked(db,pid);await runtime.query('commit');
  await pgFails(pending,'23514','agenda_capacity_exceeded');
 });
 assert.deepEqual(await counts(db,agenda.cohort),{active:1,matches:1,jobs:1});
 assert.deepEqual((await db.query("select actor_user_id from audit_event where action='enrollment.create'")).rows,[{actor_user_id:p.id}],'só a reserva da API, com o ator autenticado');
}));

test('I5 sobreposição: SQL direto do dono segura o guard reservando a participante num horário → POST /me/enrollments em horário sobreposto de outra mentora espera → 409 SCHEDULE_CONFLICT',()=>withDb(async({db,url})=>{
 const x=await mentorWithCohort(db,{from:30,hours:2}),y=await mentorWithCohort(db,{from:31,hours:2});const p=await participantActor(db);
 await withClients(url,[DIRECT_SQL],async direct=>{
  const r=await directFirst(db,direct,enrollSql,[p.participantId,x.cohort],()=>as(p).send(enrollments.POST,ME,{body:{cohortId:y.cohort},key:randomUUID()}));
  assert.deepEqual([r.status,code(r)],[409,'SCHEDULE_CONFLICT']);
 });
 assert.deepEqual((await db.query("select cohort_id::text c from enrollment where participant_id=$1 and status='active'",[p.participantId])).rows,[{c:x.cohort}]);
}));

test('I5 realocação × redução de capacidade: SQL direto do dono segura o guard reduzindo o destino à ocupação → realocação admin espera → 409 COHORT_FULL e a reserva de origem continua ativa',()=>withDb(async({db,url})=>{
 const admin=await actorOf(db,['admin']);const origin=await mentorWithCohort(db,{from:40,capacity:3}),destination=await mentorWithCohort(db,{from:50,capacity:2});
 const moving=await addParticipant(db);const e=(await db.query(enrollSql,[moving,origin.cohort])).rows[0].id;await db.query(enrollSql,[await addParticipant(db),destination.cohort]);
 await withClients(url,[DIRECT_SQL],async direct=>{
  const r=await directFirst(db,direct,'update cohort set capacity=1 where id=$1',[destination.cohort],
   ()=>as(admin).send(reassign.POST,`/api/v1/admin/enrollments/${e}/reassign`,{body:{cohortId:destination.cohort,confirm:true},params:{id:e},key:randomUUID()}));
  assert.deepEqual([r.status,code(r)],[409,'COHORT_FULL']);
 });
 assert.deepEqual((await db.query('select status from enrollment where id=$1',[e])).rows[0],{status:'active'},'origem preservada (nada parcial)');
 assert.deepEqual(await counts(db,destination.cohort),{active:1,matches:1,jobs:1});
 assert.equal((await db.query('select capacity from cohort where id=$1',[destination.cohort])).rows[0].capacity,1);
}));

test('I5 REPEATABLE READ do SQL direto (dono): snapshot anterior ao commit da API (POST /me/enrollments) → 40001 no guard; retry integral revalida e recusa a vaga',()=>withDb(async({db,url})=>{
 const agenda=await mentorWithCohort(db,{capacity:1,from:20});const p=await participantActor(db);const other=await addParticipant(db);
 await withClients(url,[DIRECT_SQL],async direct=>{
  await direct.query('begin isolation level repeatable read');
  assert.equal((await direct.query("select count(*)::int n from enrollment where cohort_id=$1 and status='active'",[agenda.cohort])).rows[0].n,0,'snapshot com a vaga livre');
  const r=await as(p).send(enrollments.POST,ME,{body:{cohortId:agenda.cohort},key:randomUUID()});assert.equal(r.status,201);
  await pgFails(direct.query(enrollSql,[other,agenda.cohort]),'40001');await direct.query('rollback');
  // retry integral (nova transação, mesmo isolamento): consulta nova vê a vaga tomada e o banco recusa
  await direct.query('begin isolation level repeatable read');
  await pgFails(direct.query(enrollSql,[other,agenda.cohort]),'23514','agenda_capacity_exceeded');await direct.query('rollback');
 });
 assert.deepEqual(await counts(db,agenda.cohort),{active:1,matches:1,jobs:1});
}));
