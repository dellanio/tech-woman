import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withDb,withClients,revision,pgFails,addTopic,addMentor,addParticipant,addMentorTopic,addCohort,startedCohort,at} from './agenda-harness';
import {OWNER} from './agenda-harness';

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

test('temas: no máximo dois vínculos por mentora, mesmo com UNIQUE de posição adiado; par único; troca atômica de posições', ()=>withDb(async ({db,url})=>{
 const mentor=await addMentor(db),[t1,t2,t3]=[await addTopic(db),await addTopic(db),await addTopic(db)];
 const a=await addMentorTopic(db,mentor,t1,1),b=await addMentorTopic(db,mentor,t2,2);
 await pgFails(addMentorTopic(db,mentor,t3,3),'23514','mentor_topic_position_check');
 await pgFails(addMentorTopic(db,mentor,t3,1),'23505','mentor_topic_position_unique');
 await pgFails(db.query('update mentor_topic set topic_id=$2 where id=$1',[b,t1]),'23505','mentor_topic_pair_unique');
 await withClients(url,[undefined],async c=>{
  await c.query('begin');await c.query('set constraints mentor_topic_position_unique deferred');
  await pgFails(c.query('insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,1)',[mentor,t3]),'23514','agenda_topic_limit');
  await c.query('rollback');
  await c.query('begin');await c.query('set constraints mentor_topic_position_unique deferred');
  await c.query('update mentor_topic set position=3-position where mentor_id=$1',[mentor]);await c.query('commit');
 });
 assert.deepEqual((await db.query('select id::text,position from mentor_topic where mentor_id=$1 order by id',[mentor])).rows,[{id:a,position:2},{id:b,position:1}]);
}));

test('turma: criação só draft/open e futura; transições exatas do DER; cancelada é terminal; reabrir exige futura', ()=>withDb(async ({db,url})=>{
 const mentor=await addMentor(db),mt=await addMentorTopic(db,mentor,await addTopic(db));
 for(const status of ['closed','cancelled']) await pgFails(addCohort(db,mt,{from:0,status}),'23514','agenda_invalid_transition');
 await pgFails(db.query("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,now()-interval '1 minute',now()+interval '1 hour',5,'draft')",[mt]),'23514','agenda_not_future');
 const c=await addCohort(db,mt,{from:0,status:'draft'});
 const to=(status:string)=>db.query('update cohort set status=$2 where id=$1',[c,status]);
 await pgFails(to('closed'),'23514','agenda_invalid_transition');
 await to('open');await pgFails(to('draft'),'23514','agenda_invalid_transition');
 await to('closed');await to('open');await to('closed');await to('cancelled');
 for(const status of ['open','draft','closed']) await pgFails(to(status),'23514','agenda_invalid_transition');
 await pgFails(db.query('update cohort set capacity=7 where id=$1',[c]),'23514','agenda_invalid_transition');
 const started=await startedCohort(url,mt,{hoursAgo:1,status:'closed'});
 await pgFails(db.query("update cohort set status='open' where id=$1",[started]),'23514','agenda_not_future');
 await db.query("update cohort set status='cancelled' where id=$1",[started]);
 const later=await addCohort(db,mt,{from:5});
 await pgFails(db.query("update cohort set starts_at=now()-interval '1 hour' where id=$1",[later]),'23514','agenda_not_future');
 await db.query('update cohort set starts_at=$2,ends_at=$3 where id=$1',[later,at(6),at(7)]);
}));

test('imutabilidade: ids, slug, mentora do vínculo e FKs de inscrição; tema do vínculo só troca sem turma', ()=>withDb(async ({db})=>{
 const mentor=await addMentor(db),other=await addMentor(db),participant=await addParticipant(db),[t1,t2,t3]=[await addTopic(db),await addTopic(db),await addTopic(db)];
 const used=await addMentorTopic(db,mentor,t1,1),free=await addMentorTopic(db,mentor,t2,2),c=await addCohort(db,used,{from:0});
 await pgFails(db.query("update topic set slug='novo-slug' where id=$1",[t1]),'23514','agenda_immutable');
 await pgFails(db.query('update topic set id=id+1000 where id=$1',[t1]),'23514','agenda_immutable');
 await pgFails(db.query('update mentor_topic set mentor_id=$2 where id=$1',[free,other]),'23514','agenda_immutable');
 await pgFails(db.query('update mentor_topic set topic_id=$2 where id=$1',[used,t3]),'23514','agenda_cohort_in_use');
 await db.query('update mentor_topic set topic_id=$2 where id=$1',[free,t3]);
 await pgFails(db.query('update cohort set id=id+1000 where id=$1',[c]),'23514','agenda_immutable');
 await pgFails(db.query('update mentor set id=id+1000 where id=$1',[mentor]),'23514','agenda_immutable');
 await pgFails(db.query('update participant set id=id+1000 where id=$1',[participant]),'23514','agenda_immutable');
 const e=(await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id::text",[participant,c])).rows[0].id;
 const other2=await addCohort(db,await addMentorTopic(db,other,t1),{from:3});
 await pgFails(db.query('update enrollment set cohort_id=$2 where id=$1',[e,other2]),'23514','agenda_immutable');
 await pgFails(db.query('update enrollment set participant_id=$2 where id=$1',[e,await addParticipant(db)]),'23514','agenda_immutable');
 await pgFails(db.query('update enrollment set id=id+1000 where id=$1',[e]),'23514','agenda_immutable');
}));

test('capacidade 1..20, ocupação ≤ capacidade, redução abaixo da ocupação e cancelar/desativar com reservas ativas recusados', ()=>withDb(async ({db})=>{
 const mentor=await addMentor(db),topic=await addTopic(db),mt=await addMentorTopic(db,mentor,topic);
 for(const capacity of [0,21]) await pgFails(addCohort(db,mt,{from:0,capacity}),'23514','cohort_capacity_check');
 await addCohort(db,mt,{from:10,capacity:20});
 const c=await addCohort(db,mt,{from:0,capacity:2}),[p1,p2,p3]=[await addParticipant(db),await addParticipant(db),await addParticipant(db)];
 const enroll=(p:string)=>db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id::text",[p,c]).then(r=>r.rows[0].id as string);
 const e1=await enroll(p1);await enroll(p2);
 await pgFails(enroll(p3),'23514','agenda_capacity_exceeded');
 await pgFails(db.query('update cohort set capacity=1 where id=$1',[c]),'23514','agenda_capacity_exceeded');
 await pgFails(db.query("update cohort set status='cancelled' where id=$1",[c]),'23514','agenda_cohort_in_use');
 await pgFails(db.query('update cohort set starts_at=$2,ends_at=$3 where id=$1',[c,at(2),at(3)]),'23514','agenda_cohort_in_use');
 for(const [table,id] of [['topic',topic],['mentor',mentor],['participant',p1]]) await pgFails(db.query(`update ${table} set active=false where id=$1`,[id]),'23514','agenda_active_enrollment');
 await db.query("update cohort set status='closed' where id=$1",[c]);
 assert.equal((await db.query("select count(*)::int n from enrollment where cohort_id=$1 and status='active'",[c])).rows[0].n,2,'closed retém reservas');
 await db.query("update enrollment set status='cancelled' where id=$1",[e1]);
 await db.query('update cohort set capacity=1 where id=$1',[c]);
 await db.query('update participant set active=false where id=$1',[p1]);
}));

const AGENDA_FUNCTIONS=['acquire_agenda_guard','validate_agenda_state','agenda_row_check','agenda_reject'];
test('segurança SQL: owner NOLOGIN sem BYPASSRLS; funções de Agenda dele, search_path fixo, VOLATILE, sem EXECUTE para PUBLIC/runtime', ()=>withDb(async ({db})=>{
 const role=(await db.query('select rolcanlogin,rolbypassrls,rolsuper,rolcreaterole,rolcreatedb,rolreplication from pg_roles where rolname=$1',[OWNER])).rows[0];
 assert.deepEqual(role,{rolcanlogin:false,rolbypassrls:false,rolsuper:false,rolcreaterole:false,rolcreatedb:false,rolreplication:false});
 const fns=(await db.query(`select p.proname,pg_get_userbyid(p.proowner) owner,p.prosecdef,p.provolatile,p.proconfig,
   coalesce((select array_agg(coalesce(nullif(pg_get_userbyid(a.grantee)::text,''),'-')) from aclexplode(p.proacl) a where a.privilege_type='EXECUTE' and a.grantee<>p.proowner),'{}') grantees,
   has_function_privilege('techwoman_runtime',p.oid,'EXECUTE') runtime
  from pg_proc p where p.pronamespace='internal'::regnamespace and p.proname=any($1) order by p.proname`,[AGENDA_FUNCTIONS])).rows;
 assert.equal(fns.length,AGENDA_FUNCTIONS.length);
 for(const f of fns){
  assert.equal(f.owner,OWNER,`${f.proname} owner`);assert.equal(f.provolatile,'v',`${f.proname} VOLATILE`);
  assert.deepEqual(f.proconfig,['search_path=pg_catalog, pg_temp'],`${f.proname} search_path`);
  assert.deepEqual(f.grantees,[],`${f.proname} sem EXECUTE concedido (inclusive PUBLIC)`);assert.equal(f.runtime,false);
  if(f.proname!=='agenda_reject')assert.equal(f.prosecdef,true,`${f.proname} SECURITY DEFINER`);
 }
 assert.equal((await db.query("select count(*)::int n from pg_proc where pronamespace='internal'::regnamespace and proname=any($1) and prosrc ~* 'execute\\s'",[AGENDA_FUNCTIONS])).rows[0].n,0,'sem SQL dinâmico');
}));
