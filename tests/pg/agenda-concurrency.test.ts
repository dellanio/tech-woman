import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Client} from 'pg';
import {withDb,withClients,connect,addUser,addTopic,addMentor,addParticipant,addMentorTopic,addCohort,pgFails,pidOf,waitLocked,EDITOR} from './agenda-harness';

const enrollSql="insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id::text";
const counts=async(db:Client|{query:Client['query']},cohort:string)=>(await db.query(`select (select count(*)::int from enrollment where cohort_id=$1 and status='active') active,
  (select count(*)::int from match m join enrollment e on e.id=m.enrollment_id where e.cohort_id=$1 and m.status='selected') matches,
  (select count(*)::int from email_job j join enrollment e on e.id=j.enrollment_id where e.cohort_id=$1 and j.status='queued') jobs`,[cohort])).rows[0];
/** A segura o guard numa transação aberta; B dispara e comprovadamente espera o lock; A confirma; devolve o resultado de B. */
async function race(control:{query:Client['query']},a:Client,b:Client,first:(c:Client)=>Promise<unknown>,second:(c:Client)=>Promise<unknown>){
 await a.query('begin');await first(a);
 const pid=await pidOf(b),pending=second(b);pending.catch(()=>undefined);
 await waitLocked(control as Client,pid);await a.query('commit');
 return pending;
}

test('última vaga em READ COMMITTED: B espera o guard e, após o commit de A, a consulta pós-lock vê a vaga tomada (SQL editora × outro cliente)', ()=>withDb(async ({db,url})=>{
 const c=await addCohort(db,await addMentorTopic(db,await addMentor(db),await addTopic(db)),{from:0,capacity:1});const [p,q]=[await addParticipant(db),await addParticipant(db)];
 await withClients(url,[undefined,EDITOR],async (a,b)=>{
  await pgFails(race(db,a,b,x=>x.query(enrollSql,[p,c]),x=>x.query(enrollSql,[q,c])),'23514','agenda_capacity_exceeded');
 });
 assert.deepEqual(await counts(db,c),{active:1,matches:1,jobs:1});
}));

test('limite 20: 21 clientes simultâneos na mesma turma → exatamente 20 sucessos e 1 recusa por capacidade, efeitos só dos vencedores', ()=>withDb(async ({db,url})=>{
 const c=await addCohort(db,await addMentorTopic(db,await addMentor(db),await addTopic(db)),{from:0,capacity:20});
 const people=await Promise.all(Array.from({length:21},()=>addParticipant(db)));
 const clients=await Promise.all(people.map((_,i)=>connect(url,i%2?EDITOR:undefined)));
 try{
  await Promise.all(clients.map(x=>x.query('begin')));
  const results=await Promise.allSettled(clients.map((x,i)=>x.query(enrollSql,[people[i],c]).then(()=>x.query('commit')).catch(async e=>{await x.query('rollback');throw e;})));
  const failed=results.filter(r=>r.status==='rejected') as PromiseRejectedResult[];
  assert.equal(results.length-failed.length,20);assert.equal(failed.length,1);
  assert.equal(failed[0].reason.constraint,'agenda_capacity_exceeded');
 }finally{await Promise.all(clients.map(x=>x.end()));}
 assert.deepEqual(await counts(db,c),{active:20,matches:20,jobs:20});
}));

test('duplicata simultânea da mesma participante na mesma turma: uma reserva, a outra recusada por enrollment_active_unique', ()=>withDb(async ({db,url})=>{
 const c=await addCohort(db,await addMentorTopic(db,await addMentor(db),await addTopic(db)),{from:0,capacity:5});const p=await addParticipant(db);
 await withClients(url,[EDITOR,undefined],async (a,b)=>{
  await pgFails(race(db,a,b,x=>x.query(enrollSql,[p,c]),x=>x.query(enrollSql,[p,c])),'23505','enrollment_active_unique');
 });
 assert.deepEqual(await counts(db,c),{active:1,matches:1,jobs:1});
}));

test('mesma participante em mentoras diferentes com horários sobrepostos, simultâneo: só uma reserva', ()=>withDb(async ({db,url})=>{
 const x=await addCohort(db,await addMentorTopic(db,await addMentor(db),await addTopic(db)),{from:0}),y=await addCohort(db,await addMentorTopic(db,await addMentor(db),await addTopic(db)),{from:0.5});
 const p=await addParticipant(db);
 await withClients(url,[undefined,EDITOR],async (a,b)=>{
  await pgFails(race(db,a,b,k=>k.query(enrollSql,[p,x]),k=>k.query(enrollSql,[p,y])),'23514','agenda_participant_overlap');
 });
 assert.equal((await db.query("select count(*)::int n from enrollment where participant_id=$1 and status='active'",[p])).rows[0].n,1);
}));

test('REPEATABLE READ: snapshot anterior a uma reserva concorrente falha com 40001; nova tentativa integral revalida e respeita a vaga', ()=>withDb(async ({db,url})=>{
 const c=await addCohort(db,await addMentorTopic(db,await addMentor(db),await addTopic(db)),{from:0,capacity:1});const [p,q]=[await addParticipant(db),await addParticipant(db)];
 await withClients(url,[EDITOR,undefined],async (a,b)=>{
  await a.query('begin isolation level repeatable read');
  assert.equal((await a.query("select count(*)::int n from enrollment where cohort_id=$1 and status='active'",[c])).rows[0].n,0);
  await b.query(enrollSql,[q,c]);
  await pgFails(a.query(enrollSql,[p,c]),'40001');await a.query('rollback');
  await a.query('begin isolation level repeatable read');
  await pgFails(a.query(enrollSql,[p,c]),'23514','agenda_capacity_exceeded');await a.query('rollback');
 });
 assert.deepEqual(await counts(db,c),{active:1,matches:1,jobs:1});
}));

test('redução de capacidade × reserva simultâneas, nas duas ordens: ocupação nunca excede a capacidade', ()=>withDb(async ({db,url})=>{
 const mt=await addMentorTopic(db,await addMentor(db),await addTopic(db));
 const c1=await addCohort(db,mt,{from:0,capacity:2}),c2=await addCohort(db,mt,{from:2,capacity:2});
 const [p,q,r,s]=await Promise.all([0,1,2,3].map(()=>addParticipant(db)));
 await db.query(enrollSql,[p,c1]);await db.query(enrollSql,[r,c2]);
 await withClients(url,[EDITOR,undefined],async (a,b)=>{
  await pgFails(race(db,a,b,k=>k.query('update cohort set capacity=1 where id=$1',[c1]),k=>k.query(enrollSql,[q,c1])),'23514','agenda_capacity_exceeded');
  await pgFails(race(db,a,b,k=>k.query(enrollSql,[s,c2]),k=>k.query('update cohort set capacity=1 where id=$1',[c2])),'23514','agenda_capacity_exceeded');
 });
 assert.deepEqual((await db.query("select c.capacity::int,(select count(*)::int from enrollment e where e.cohort_id=c.id and e.status='active') occupied from cohort c order by c.id")).rows,[{capacity:1,occupied:1},{capacity:2,occupied:2}]);
}));

test('realocação atômica em transação SQL: cancelar origem + reservar destino; destino sem vaga desfaz tudo e preserva a origem', ()=>withDb(async ({db,url})=>{
 const mt=await addMentorTopic(db,await addMentor(db),await addTopic(db));
 const origin=await addCohort(db,mt,{from:0}),target=await addCohort(db,mt,{from:2,capacity:1}),spare=await addCohort(db,mt,{from:4});
 const [p,q]=[await addParticipant(db),await addParticipant(db)];
 const e=(await db.query(enrollSql,[p,origin])).rows[0].id;await db.query(enrollSql,[q,target]);
 const snapshot=async()=>(await db.query("select string_agg(x,'|' order by x) s from (select e::text x from enrollment e union all select m::text from match m union all select j.status||j.dedupe_key from email_job j) t")).rows[0].s;
 const before=await snapshot();
 await withClients(url,[EDITOR],async b=>{
  await b.query('begin');await b.query("update enrollment set status='cancelled' where id=$1",[e]);
  await pgFails(b.query(enrollSql,[p,target]),'23514','agenda_capacity_exceeded');await b.query('rollback');
  assert.equal(await snapshot(),before,'falha no destino mantém a reserva anterior intacta');
  await b.query('begin');await b.query("update enrollment set status='cancelled' where id=$1",[e]);await b.query(enrollSql,[p,spare]);await b.query('commit');
 });
 assert.deepEqual((await db.query("select e.cohort_id::text cohort,e.status,m.status match from enrollment e join match m on m.enrollment_id=e.id where e.participant_id=$1 order by e.id",[p])).rows,
  [{cohort:origin,status:'cancelled',match:'cancelled'},{cohort:spare,status:'active',match:'selected'}]);
}));

test('linhas ocultas sob concorrência: reserva de participante protegida (invisível à editora) em andamento bloqueia a última vaga corretamente', ()=>withDb(async ({db,url})=>{
 const admin=await addUser(db,{roles:['admin','participant']});const hidden=await addParticipant(db,{userId:admin.id,email:admin.email});
 const c=await addCohort(db,await addMentorTopic(db,await addMentor(db),await addTopic(db)),{from:0,capacity:1});const p=await addParticipant(db);
 await withClients(url,[undefined,EDITOR],async (a,b)=>{
  await pgFails(race(db,a,b,k=>k.query(enrollSql,[hidden,c]),k=>k.query(enrollSql,[p,c])),'23514','agenda_capacity_exceeded');
  assert.equal((await b.query('select count(*)::int n from enrollment where cohort_id=$1',[c])).rows[0].n,0,'editora não vê a reserva protegida');
 });
 assert.deepEqual(await counts(db,c),{active:1,matches:1,jobs:1});
}));
