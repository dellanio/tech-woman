import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withDb,withClients,revision,pgFails,addTopic,addMentor,addParticipant,addMentorTopic,addCohort,startedCohort,at} from './agenda-harness';
import {OWNER,EDITOR,addUser,linkFixture,applyLocalGrants,pidOf,waitLocked} from './agenda-harness';
import {readFileSync} from 'node:fs';

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

const AGENDA_FUNCTIONS=['acquire_agenda_guard','validate_agenda_state','agenda_row_check','agenda_reject','agenda_mentor_topic_active'];
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
  assert.equal(f.proconfig[0],'search_path=pg_catalog, pg_temp',`${f.proname} search_path`);
  assert.deepEqual(f.grantees,[],`${f.proname} sem EXECUTE concedido (inclusive PUBLIC)`);assert.equal(f.runtime,false);
  if(!['agenda_reject','agenda_mentor_topic_active'].includes(f.proname))assert.equal(f.prosecdef,true,`${f.proname} SECURITY DEFINER`);
 }
 const helper=(await db.query(`select pg_get_userbyid(proowner)::text owner,prosecdef,proconfig,has_function_privilege('techwoman_beatriz',oid,'EXECUTE') editor,
   has_function_privilege('techwoman_runtime',oid,'EXECUTE') runtime,has_function_privilege('techwoman_mailer',oid,'EXECUTE') mailer from pg_proc where oid='internal.agenda_editor_visible(text,bigint)'::regprocedure`)).rows[0];
 assert.deepEqual(helper,{owner:OWNER,prosecdef:true,proconfig:['search_path=pg_catalog, pg_temp'],editor:true,runtime:false,mailer:false},'helper booleano de visibilidade só para a editora');
 assert.equal((await db.query("select count(*)::int n from pg_proc where pronamespace='internal'::regnamespace and proname=any($1) and prosrc ~* 'execute\\s'",[AGENDA_FUNCTIONS])).rows[0].n,0,'sem SQL dinâmico');
}));

test('editora: DML por coluna em agenda e perfis; views sem e-mail/token; negados hashes, identidade, auditoria, guard, DELETE destrutivo, TRUNCATE, DDL, DISABLE TRIGGER e owner', ()=>withDb(async ({db,url})=>{
 const mentor=await addMentor(db),participant=await addParticipant(db),topic=await addTopic(db),spare=await addTopic(db);
 await withClients(url,[EDITOR],async b=>{
  const ok=(sql:string,args:unknown[]=[])=>b.query(sql,args);
  const denied=(sql:string,args:unknown[]=[])=>pgFails(b.query(sql,args),'42501');
  await ok("insert into topic(slug,name,description) values('editora','Editora','d')");await ok("update topic set name='E2',active=true where slug='editora'");
  const mt=(await ok("insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,1) returning id",[mentor,topic])).rows[0].id;
  const tmp=(await ok("insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,2) returning id",[mentor,spare])).rows[0].id;
  await ok('update mentor_topic set position=2 where id=$1',[tmp]);await ok('delete from mentor_topic where id=$1',[tmp]);
  const c=(await ok("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,$2,$3,20,'draft') returning id",[mt,at(0),at(1)])).rows[0].id;
  await ok("update cohort set capacity=10,status='open' where id=$1",[c]);
  const e=(await ok("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id",[participant,c])).rows[0].id;
  await ok("update enrollment set status='cancelled' where id=$1",[e]);
  await ok("update participant set goal='leadership',moment='returning',interests='[\"dados\"]',skills='[\"gestao\"]',area='dados',active=true where id=$1",[participant]);
  await ok("update mentor set display_name='Nova',trajectory='t2',specialties='[]',availability='a2',capacity=3,active=true where id=$1",[mentor]);
  assert.equal((await ok('select id,goal,moment,interests,skills,area,active,version from participant_editor where id=$1',[participant])).rowCount,1);
  assert.equal((await ok('select id,display_name,trajectory,specialties,availability,capacity,active,demo,version from mentor_editor where id=$1',[mentor])).rowCount,1);
  await ok('select id,goal,active from participant');await ok('select id,display_name,active from mentor');
  for(const sql of ['select * from participant','select email from participant','select token_hash from participant','select user_id from participant','select * from mentor','select email from mentor','select user_id from mentor',
   'select * from app_user','select 1 from user_role','select 1 from auth_session','select 1 from password_reset_token','select 1 from email_job','select 1 from email_delivery_attempt',
   'select 1 from audit_event','select 1 from match','select 1 from migration_identity_link','select 1 from migration_issue','select 1 from api_idempotency','select 1 from internal.agenda_guard','select 1 from legacy_snapshot.source_row',
   "insert into audit_event(action,entity_type,entity_id,changed_fields,result,request_id) values('x','x','x','[]','ok',gen_random_uuid())",'update internal.agenda_guard set revision=0'])await denied(sql);
  for(const sql of ["update participant set email='x@example.invalid' where id=$1","update participant set token_hash='x' where id=$1","update participant set user_id=null where id=$1","update participant set consent_version='x' where id=$1",
   "update mentor set email='x@example.invalid' where id=$1","update mentor set user_id=null where id=$1","update mentor set demo=true where id=$1","update mentor set consent_at=now() where id=$1"])await denied(sql,[participant]);
  for(const t of ['participant','mentor','enrollment','cohort','topic','match'])await denied(`delete from ${t} where id=0`);
  await denied("update enrollment set cohort_id=cohort_id where id=$1",[e]);await denied("insert into topic(id,slug,name) values(999,'forcado','F')");
  for(const sql of ['truncate topic','alter table topic disable trigger all','alter table cohort disable trigger agenda_validate','create table public.editora_x(id int)','drop trigger agenda_guard on topic',
   "select setval('topic_id_seq',100)",'select internal.domain_protected(\'participant\',1)'])await denied(sql);
 });
 // SET ROLE é checado contra session_user (superusuário no teste); a propriedade real é não pertencer a roles privilegiadas.
 for(const target of [OWNER,'techwoman_runtime','techwoman_mailer'])assert.equal((await db.query("select pg_has_role($1,$2,'MEMBER') m",[EDITOR,target])).rows[0].m,false,`editora não é membro de ${target}`);
 const viewCols=(await db.query("select table_name,string_agg(column_name,',' order by column_name) cols from information_schema.columns where table_name in ('participant_editor','mentor_editor') group by table_name order by table_name")).rows;
 for(const v of viewCols)assert.doesNotMatch(v.cols,/email|token|user_id|consent|hash/,`${v.table_name} sem colunas sensíveis`);
 assert.equal(viewCols.length,2);
}));

const AGENDA_TABLES=['topic','mentor_topic','cohort','enrollment','mentor','participant'];
test('R3/RLS forçada: editora não vê nem altera domínio de admin vinculado nem candidato privilegiado sem user_id; validador e runtime veem o conjunto integral', ()=>withDb(async ({db,url})=>{
 const admin=await addUser(db,{roles:['admin','mentor','participant']});const team=await addUser(db,{roles:['team']});
 const adminMentor=await addMentor(db,{userId:admin.id}),adminParticipant=await addParticipant(db,{userId:admin.id});
 const sameEmailMentor=await addMentor(db,{email:` ${team.email.toUpperCase()} `});
 const candidateEmail='candidata@example.invalid',ambiguousEmail='ambigua@example.invalid';const links=await linkFixture(db);
 await links.link('admin_user',candidateEmail,null,'privileged_candidate');await links.link('participant','999999',null,'ambiguous_domain');
 const candidate=await addParticipant(db,{email:candidateEmail}),ambiguous=await addParticipant(db,{email:ambiguousEmail});
 const mentor=await addMentor(db),participant=await addParticipant(db),topic=await addTopic(db);
 const hiddenMt=await addMentorTopic(db,adminMentor,topic),hiddenCohort=await addCohort(db,hiddenMt,{from:0,capacity:3});
 const mt=await addMentorTopic(db,mentor,topic),full=await addCohort(db,mt,{from:2,capacity:1});
 await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[adminParticipant,full]);
 await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[participant,hiddenCohort]);
 const rls=(await db.query("select relname,relrowsecurity,relforcerowsecurity from pg_class where oid=any($1::regclass[]) order by relname",[AGENDA_TABLES.map(t=>'public.'+t)])).rows;
 assert.ok(rls.length===6&&rls.every(r=>r.relrowsecurity&&r.relforcerowsecurity),'RLS habilitada e FORCE nas seis tabelas');
 await applyLocalGrants(db);
 const before=(await db.query("select string_agg(t::text,'|' order by t::text) s from (select p::text from participant p union all select m::text from mentor m) x(t)")).rows[0].s;
 await withClients(url,[EDITOR,'techwoman_runtime'],async (b,runtime)=>{
  const ids=async(sql:string)=>(await b.query(sql)).rows.map(r=>String(r.id)).sort();
  assert.deepEqual(await ids('select id from participant'),[ambiguous,participant].sort(),'admin vinculado e candidato privilegiado ocultos; ambíguo não é privilégio');
  assert.deepEqual(await ids('select id from participant_editor'),[ambiguous,participant].sort());
  assert.deepEqual(await ids('select id from mentor'),[mentor]);assert.deepEqual(await ids('select id from mentor_editor'),[mentor]);
  assert.deepEqual(await ids('select id from mentor_topic'),[mt]);assert.deepEqual(await ids('select id from cohort'),[full]);
  assert.deepEqual(await ids('select id from enrollment'),[],'reservas com participante ou mentora protegida ocultas');
  assert.equal((await b.query('select count(*)::int n from topic')).rows[0].n,1);
  for(const [sql,args] of [["update participant set goal='leadership' where id=any($1)",[[adminParticipant,candidate]]],["update mentor set trajectory='x' where id=any($1)",[[adminMentor,sameEmailMentor]]],
   ["update cohort set capacity=2 where id=$1",[hiddenCohort]],["delete from mentor_topic where id=$1",[hiddenMt]],["update enrollment set status='cancelled' where cohort_id=$1",[hiddenCohort]]] as const)
   assert.equal((await b.query(sql,[...args])).rowCount,0,sql);
  await pgFails(b.query('insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,2)',[adminMentor,topic]),'42501');
  await pgFails(b.query("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,$2,$3,2,'open')",[hiddenMt,at(5),at(6)]),'42501');
  await pgFails(b.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[candidate,full]),'42501');
  await pgFails(b.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[ambiguous,hiddenCohort]),'42501');
  await pgFails(b.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[ambiguous,full]),'23514','agenda_capacity_exceeded');
  assert.equal((await runtime.query('select count(*)::int n from participant')).rows[0].n,4,'runtime aplica a exclusão no serviço, não perde linhas');
  assert.equal((await runtime.query('select count(*)::int n from mentor')).rows[0].n,3);
 });
 assert.equal((await db.query("select string_agg(t::text,'|' order by t::text) s from (select p::text from participant p union all select m::text from mentor m) x(t)")).rows[0].s,before,'nenhuma mutação em linha protegida');
 assert.equal((await db.query("select count(*)::int n from enrollment where status='active'")).rows[0].n,2);
}));

test('lote da editora: um item inválido desfaz o statement inteiro (INSERT/UPDATE multi-linha)', ()=>withDb(async ({db,url})=>{
 const mentor=await addMentor(db),mt=await addMentorTopic(db,mentor,await addTopic(db)),c=await addCohort(db,mt,{from:0,capacity:2});
 const [p1,p2,p3]=[await addParticipant(db),await addParticipant(db),await addParticipant(db)];
 await withClients(url,[EDITOR],async b=>{
  await pgFails(b.query("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,$2,$3,5,'open'),($1,$4,$5,5,'open')",[mt,at(3),at(4),at(3.5),at(4.5)]),'23514','agenda_mentor_overlap');
  await pgFails(b.query("insert into enrollment(participant_id,cohort_id,status) select p,$2,'active' from unnest($1::bigint[]) p",[[p1,p2,p3],c]),'23514','agenda_capacity_exceeded');
  await b.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active'),($3,$2,'active')",[p1,c,p2]);
  await pgFails(b.query('update cohort set capacity=case when id=$1 then 1 else capacity end, ends_at=ends_at where id in (select id from cohort)',[c]),'23514','agenda_capacity_exceeded');
 });
 assert.deepEqual((await db.query("select (select count(*)::int from cohort) cohorts,(select count(*)::int from enrollment) enrollments,(select capacity::int from cohort where id=$1) capacity",[c])).rows[0],{cohorts:1,enrollments:2,capacity:2});
}));

test('limites finitos: guard com lock_timeout próprio; script do operador fixa timeouts da editora e é idempotente', ()=>withDb(async ({db,url})=>{
 const script=readFileSync('scripts/migration/agenda-privileges.sql','utf8');await db.query(script);await db.query(script);
 const cfg=(await db.query('select rolconfig from pg_roles where rolname=$1',[EDITOR])).rows[0].rolconfig as string[];
 for(const key of ['lock_timeout','statement_timeout','idle_in_transaction_session_timeout']){
  const v=cfg.find(x=>x.startsWith(key+'='));assert.ok(v&&!/=0$/.test(v),`${key} finito para a editora: ${v}`);
 }
 const guard=(await db.query("select proconfig from pg_proc where oid='internal.acquire_agenda_guard()'::regprocedure")).rows[0].proconfig as string[];
 assert.ok(guard.some(x=>/^lock_timeout=\d+s$/.test(x)),'guard com lock_timeout fixo');
 const owner=(await db.query('select rolcanlogin,rolbypassrls from pg_roles where rolname=$1',[OWNER])).rows[0];assert.deepEqual(owner,{rolcanlogin:false,rolbypassrls:false});
 await withClients(url,[undefined,EDITOR],async (holder,b)=>{
  await holder.query('begin');await holder.query("insert into topic(slug,name) values('segura-guard','S')");
  const pid=await pidOf(b),started=Date.now();const pending=b.query("insert into topic(slug,name) values('espera-guard','E')");
  pending.catch(()=>undefined);await waitLocked(db,pid);
  await pgFails(pending,'55P03');assert.ok(Date.now()-started<15000,'espera pelo guard é finita');
  await holder.query('rollback');
 });
}));

test('turma elegível: criar ou abrir exige mentora e tema ativos; fechar e cancelar continuam permitidos', ()=>withDb(async ({db})=>{
 const mentor=await addMentor(db),topic=await addTopic(db),mt=await addMentorTopic(db,mentor,topic);
 const draft=await addCohort(db,mt,{from:0,status:'draft'}),open=await addCohort(db,mt,{from:2});
 await db.query('update topic set active=false where id=$1',[topic]);
 await pgFails(addCohort(db,mt,{from:4}),'23514','agenda_inactive');
 await pgFails(db.query("update cohort set status='open' where id=$1",[draft]),'23514','agenda_inactive');
 await db.query("update cohort set status='closed' where id=$1",[open]);
 await db.query('update topic set active=true where id=$1',[topic]);await db.query('update mentor set active=false where id=$1',[mentor]);
 await pgFails(addCohort(db,mt,{from:4,status:'draft'}),'23514','agenda_inactive');
 await pgFails(db.query("update cohort set status='open' where id=$1",[open]),'23514','agenda_inactive');
 await db.query("update cohort set status='cancelled' where id in ($1,$2)",[draft,open]);
}));

test('R3: RLS é avaliada antes das regras de elegibilidade — tentativa sobre linha oculta não revela estado (42501, nunca motivo de negócio)', ()=>withDb(async ({db,url})=>{
 const admin=await addUser(db,{roles:['admin','mentor']});const adminMentor=await addMentor(db,{userId:admin.id});
 const hiddenMt=await addMentorTopic(db,adminMentor,await addTopic(db));await db.query('update mentor set active=false where id=$1',[adminMentor]);
 await withClients(url,[EDITOR],async b=>{
  await pgFails(b.query("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,$2,$3,2,'open')",[hiddenMt,at(1),at(2)]),'42501');
  await pgFails(b.query("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,now()-interval '1 hour',now(),2,'closed')",[hiddenMt]),'42501');
 });
}));
