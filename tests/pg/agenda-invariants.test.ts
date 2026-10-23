import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withDb,withClients,revision,pgFails,addTopic,addMentor,addParticipant,addMentorTopic,addCohort} from './agenda-harness';

test('guard: todo statement DML nas seis tabelas escreve agenda_guard.revision, inclusive sem linhas', ()=>withDb(async ({db})=>{
 const mentor=await addMentor(db),participant=await addParticipant(db),topic=await addTopic(db);
 const mt=await addMentorTopic(db,mentor,topic),cohort=await addCohort(db,mt);
 const statements=[
  ["update topic set name='Outro' where id=$1",[topic]],["update mentor_topic set position=1 where id=$1",[mt]],
  ["update cohort set capacity=6 where id=$1",[cohort]],["update mentor set trajectory='x' where id=$1",[mentor]],
  ["update participant set goal='leadership' where id=$1",[participant]],
  ["update enrollment set status='cancelled' where false",[]],["delete from enrollment where false",[]],
  ["insert into topic(slug,name) values('guard-insert','G')",[]],["delete from topic where slug='guard-insert'",[]],
 ] as const;
 for(const [sql,args] of statements){
  const before=await revision(db);await db.query(sql,[...args]);
  assert.equal(await revision(db),before+1n,`revision não avançou em: ${sql}`);
 }
}));

test('guard: snapshot REPEATABLE READ obsoleto falha com 40001 em vez de validar dados antigos', ()=>withDb(async ({url})=>{
 await withClients(url,[undefined,undefined],async (a,b)=>{
  await a.query('begin isolation level repeatable read');await a.query('select count(*) from cohort');
  await b.query("insert into topic(slug,name) values('rr-b','B')");
  await pgFails(a.query("insert into topic(slug,name) values('rr-a','A')"),'40001');
  await a.query('rollback');
  assert.equal((await b.query("select count(*)::int n from topic where slug like 'rr-%'")).rows[0].n,1);
 });
}));

test('overlap: mesma mentora em temas diferentes não pode ter turmas não canceladas sobrepostas; contíguo e cancelada valem', ()=>withDb(async ({db})=>{
 const mentor=await addMentor(db),other=await addMentor(db);
 const mt1=await addMentorTopic(db,mentor,await addTopic(db),1),mt2=await addMentorTopic(db,mentor,await addTopic(db),2);
 const otherMt=await addMentorTopic(db,other,await addTopic(db),1);
 await addCohort(db,mt1,{from:0,hours:1,status:'open'});
 for(const status of ['open','draft']) await pgFails(addCohort(db,mt2,{from:0.5,hours:1,status}),'23514','agenda_mentor_overlap');
 const contiguous=await addCohort(db,mt2,{from:1,hours:1});
 await addCohort(db,otherMt,{from:0,hours:1});
 await pgFails(db.query("update cohort set starts_at=$2 where id=$1",[contiguous,new Date(Date.parse((await db.query('select starts_at from cohort where id=$1',[contiguous])).rows[0].starts_at)-30*60e3).toISOString()]),'23514','agenda_mentor_overlap');
 const cancelled=await addCohort(db,mt2,{from:3,hours:1,status:'draft'});await db.query("update cohort set status='cancelled' where id=$1",[cancelled]);
 await addCohort(db,mt1,{from:3,hours:1});
 const closed=await addCohort(db,mt1,{from:5,hours:1});await db.query("update cohort set status='closed' where id=$1",[closed]);
 await pgFails(addCohort(db,mt2,{from:5.5,hours:1,status:'draft'}),'23514','agenda_mentor_overlap');
 assert.equal((await db.query("select count(*)::int n from cohort")).rows[0].n,6);
}));
