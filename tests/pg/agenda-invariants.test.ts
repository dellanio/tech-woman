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
