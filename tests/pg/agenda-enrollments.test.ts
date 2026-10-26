import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withDb,withClients,addUser,addTopic,addMentor,addParticipant,addMentorTopic,addCohort,startedCohort,shiftToStarted,pgFails,applyLocalGrants,DIRECT_SQL,editorWriteDenied} from './agenda-harness';
// D-048: a editora é somente leitura; a reserva/cancelamento por SQL direto destes contratos é do dono do banco (DIRECT_SQL).

test('reserva SQL direta (dono; a editora somente leitura recebe 42501): match current selected com score/reasons do ranking legado (score0 aceito), job reservation e auditoria sem dados pessoais', ()=>withDb(async ({db,url})=>{
 const user=await addUser(db,{roles:['participant']}),other=await addUser(db,{roles:['participant']});
 const participant=await addParticipant(db,{userId:user.id,email:user.email}),zero=await addParticipant(db,{userId:other.id,email:other.email,goal:'leadership',interests:['design'],skills:['gestao'],area:null});
 const mentor=await addMentor(db,{specialties:['dados','desenvolvimento']}),cohort=await addCohort(db,await addMentorTopic(db,mentor,await addTopic(db)),{from:0});
 await editorWriteDenied(url,"insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[participant,cohort]);
 const ids=await withClients(url,[DIRECT_SQL],async b=>Promise.all([participant,zero].map(async p=>(await b.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id::text",[p,cohort])).rows[0].id as string)));
 const matches=(await db.query("select participant_id::text,mentor_id::text,score,reasons,status,origin,enrollment_id::text from match order by participant_id")).rows;
 assert.deepEqual(matches,[
  {participant_id:participant,mentor_id:mentor,score:9,status:'selected',origin:'current',enrollment_id:ids[0],
   reasons:['Área de atuação em comum: dados (+3)','Objetivo e especialidades: dados (+3)','Interesses em comum: dados (+2)','Habilidades relacionadas: codigo (+1)']},
  {participant_id:zero,mentor_id:mentor,score:0,status:'selected',origin:'current',enrollment_id:ids[1],reasons:[]}]);
 const jobs=(await db.query("select user_id::text,kind,status,generation::int,participant_id::text,enrollment_id::text,dedupe_key from email_job order by participant_id")).rows;
 assert.equal(jobs.length,2);
 for(const [i,u] of [user,other].entries()){
  const j=jobs[i];assert.deepEqual({...j,dedupe_key:undefined},{user_id:u.id,kind:'reservation',status:'queued',generation:0,participant_id:[participant,zero][i],enrollment_id:ids[i],dedupe_key:undefined});
  assert.match(j.dedupe_key,new RegExp(`^reservation:${ids[i]}:`));
 }
 const audit=(await db.query("select action,entity_type,entity_id,changed_fields,result,actor_user_id from audit_event order by id")).rows;
 assert.deepEqual(audit,ids.map(id=>({action:'enrollment.create',entity_type:'enrollment',entity_id:id,changed_fields:['status'],result:'ok',actor_user_id:null})));
 assert.doesNotMatch(JSON.stringify(audit),/@|hash|token/);
}));

test('elegibilidade da reserva SQL: só active, turma open e futura, domínio ativo, identidade reconciliada ativa; duplicata e overlap da participante entre mentoras recusados; contíguo vale', ()=>withDb(async ({db,url})=>{
 const mentor=await addMentor(db),other=await addMentor(db),topic=await addTopic(db);
 const mt=await addMentorTopic(db,mentor,topic),otherMt=await addMentorTopic(db,other,await addTopic(db));
 const open=await addCohort(db,mt,{from:0}),draft=await addCohort(db,mt,{from:2,status:'draft'}),closed=await addCohort(db,mt,{from:4});
 await db.query("update cohort set status='closed' where id=$1",[closed]);
 const started=await startedCohort(url,mt,{hoursAgo:30,hours:1});
 const overlapping=await addCohort(db,otherMt,{from:0.5}),contiguous=await addCohort(db,await addMentorTopic(db,await addMentor(db),await addTopic(db)),{from:1});
 const p=await addParticipant(db),legacy=await addParticipant(db,{userId:null}),inactive=await addParticipant(db,{active:false});
 const disabledUser=await addUser(db,{status:'disabled'});const disabled=await addParticipant(db,{userId:disabledUser.id,email:disabledUser.email});
 await withClients(url,[DIRECT_SQL],async b=>{
  const enroll=(participant:string,cohort:string,status='active')=>b.query('insert into enrollment(participant_id,cohort_id,status) values($1,$2,$3)',[participant,cohort,status]);
  await pgFails(enroll(p,open,'cancelled'),'23514','agenda_invalid_transition');
  for(const c of [draft,closed])await pgFails(enroll(p,c),'23514','agenda_cohort_not_open');
  await pgFails(enroll(p,started),'23514','agenda_not_future');
  await pgFails(enroll(inactive,open),'23514','agenda_inactive');
  for(const who of [legacy,disabled])await pgFails(enroll(who,open),'23514','agenda_identity_required');
  await enroll(p,open);
  await pgFails(enroll(p,open),'23505','enrollment_active_unique');
  await pgFails(enroll(p,overlapping),'23514','agenda_participant_overlap');
  await enroll(p,contiguous);
 });
 const third=await addMentor(db),thirdTopic=await addTopic(db),free=await addCohort(db,await addMentorTopic(db,third,thirdTopic),{from:8});
 await db.query('update topic set active=false where id=$1',[thirdTopic]);
 await pgFails(db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[await addParticipant(db),free]),'23514','agenda_inactive');
 await db.query('update topic set active=true where id=$1',[thirdTopic]);await db.query('update mentor set active=false where id=$1',[third]);
 await pgFails(db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[await addParticipant(db),free]),'23514','agenda_inactive');
 assert.deepEqual((await db.query("select (select count(*)::int from enrollment) e,(select count(*)::int from match) m,(select count(*)::int from email_job) j,(select count(*)::int from audit_event) a")).rows[0],{e:2,m:2,j:2,a:2},'recusas não deixam efeitos');
}));

test('cancelar (inclusive após o início) e reativar (só futura) mantêm cancelled_at, match, job e auditoria coerentes', ()=>withDb(async ({db,url})=>{
 const mentor=await addMentor(db),mt=await addMentorTopic(db,mentor,await addTopic(db));
 const c=await addCohort(db,mt,{from:0,capacity:1}),later=await addCohort(db,mt,{from:3}),other=await addCohort(db,await addMentorTopic(db,await addMentor(db),await addTopic(db)),{from:0});
 const [p,q]=[await addParticipant(db),await addParticipant(db)];
 const state=async(id:string)=>(await db.query(`select e.status,e.cancelled_at is not null cancelled,m.status match,
   (select array_agg(j.status order by j.created_at,j.dedupe_key) from email_job j where j.enrollment_id=e.id) jobs,
   (select array_agg(a.action order by a.id) from audit_event a where a.entity_type='enrollment' and a.entity_id=e.id::text) audit
  from enrollment e join match m on m.enrollment_id=e.id where e.id=$1`,[id])).rows[0];
 await withClients(url,[DIRECT_SQL],async b=>{
  const enroll=async(who:string,cohort:string)=>(await b.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id::text",[who,cohort])).rows[0].id as string;
  const set=(id:string,status:string)=>b.query('update enrollment set status=$2 where id=$1',[id,status]);
  const e=await enroll(p,c);
  await set(e,'cancelled');
  assert.deepEqual(await state(e),{status:'cancelled',cancelled:true,match:'cancelled',jobs:['cancelled'],audit:['enrollment.create','enrollment.cancel']});
  const taken=await enroll(q,c);
  await pgFails(set(e,'active'),'23514','agenda_capacity_exceeded');
  await set(taken,'cancelled');
  const busy=await enroll(p,other);
  await pgFails(set(e,'active'),'23514','agenda_participant_overlap');
  await set(busy,'cancelled');
  await set(e,'active');
  assert.deepEqual(await state(e),{status:'active',cancelled:false,match:'selected',jobs:['cancelled','queued'],audit:['enrollment.create','enrollment.cancel','enrollment.reactivate']});
  await b.query("update enrollment set status='active' where id=$1",[e]);
  assert.equal((await state(e)).audit.length,3,'update sem transição não gera efeitos');
  const s=await enroll(q,later);await shiftToStarted(url,later);
  await set(s,'cancelled');
  assert.deepEqual(await state(s),{status:'cancelled',cancelled:true,match:'cancelled',jobs:['cancelled'],audit:['enrollment.create','enrollment.cancel']},'cancelar após o início é permitido');
  await pgFails(set(s,'active'),'23514','agenda_not_future');
 });
 await db.query("update enrollment set cancelled_at='2000-01-01T00:00:00Z' where status='active'");
 assert.equal((await db.query("select count(*)::int n from enrollment where status='active' and cancelled_at is not null")).rows[0].n,0,'cancelled_at só acompanha a transição');
 const stamp=(await db.query("update enrollment set status='cancelled',cancelled_at='2000-01-01T00:00:00Z' where participant_id=$1 and status='active' returning cancelled_at",[p])).rows[0].cancelled_at as Date;
 assert.ok(Date.now()-stamp.getTime()<60e3,'cancelled_at é o instante do cancelamento, não valor do cliente');
}));

test('match de reserva só muda pelos efeitos da inscrição: DML direto (dono da tabela; o runtime nem tem DML) não dessincroniza; score/FKs/origem imutáveis; legado segue editável no status', ()=>withDb(async ({db,url})=>{
 await applyLocalGrants(db);
 const mentor=await addMentor(db),c=await addCohort(db,await addMentorTopic(db,mentor,await addTopic(db)),{from:0});const p=await addParticipant(db),q=await addParticipant(db);
 const e=(await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id::text",[p,c])).rows[0].id;
 const legacy=(await db.query("insert into match(participant_id,mentor_id,score,reasons,status,origin) values($1,$2,3,'[]','approved','legacy') returning id::text",[q,mentor])).rows[0].id;
 const before=(await db.query('select m::text from match m where enrollment_id=$1',[e])).rows[0].m;
 // WP-003 I3: o runtime não tem DML de match (nem com os grants locais); a fixture de DML direto roda explicitamente como dono da tabela
 await withClients(url,['techwoman_runtime'],async r=>{
  await pgFails(r.query("update match set status='rejected' where id=$1",[legacy]),'42501');
  await pgFails(r.query("insert into match(participant_id,mentor_id,score,reasons,status,origin) values($1,$2,0,'[]','approved','legacy')",[q,mentor]),'42501');
 });
 await withClients(url,[undefined],async r=>{
  for(const sql of ["update match set status='cancelled' where enrollment_id=$1","update match set enrollment_id=null where enrollment_id=$1","update match set score=99 where enrollment_id=$1"])
   await pgFails(r.query(sql,[e]),'23514','agenda_match_managed');
  await pgFails(r.query("insert into match(participant_id,mentor_id,score,reasons,status,origin,enrollment_id) values($1,$2,0,'[]','selected','current',$3)",[q,mentor,e]),'23514','agenda_match_managed');
  for(const sql of ['update match set score=99 where id=$1','update match set mentor_id=mentor_id+0, participant_id=participant_id+1 where id=$1',"update match set origin='current' where id=$1"])
   await pgFails(r.query(sql,[legacy]),'23514','agenda_immutable');
  await r.query("update match set status='rejected' where id=$1",[legacy]);
 });
 assert.equal((await db.query('select m::text from match m where enrollment_id=$1',[e])).rows[0].m,before);
 assert.equal((await db.query('select status from match where id=$1',[legacy])).rows[0].status,'rejected');
}));

test('segurança SQL das funções de reserva: owner NOLOGIN, search_path fixo, VOLATILE nos triggers, sem EXECUTE para PUBLIC/runtime/editora/mailer', ()=>withDb(async ({db})=>{
 const names=['agenda_ranking','enrollment_stamp','enrollment_check_eligible','enrollment_effects','match_guard','validate_agenda_state'];
 const rows=(await db.query(`select proname,pg_get_userbyid(proowner)::text owner,provolatile,proconfig,
   exists(select 1 from aclexplode(coalesce(proacl,acldefault('f',proowner))) a where a.privilege_type='EXECUTE' and a.grantee<>proowner) granted,
   has_function_privilege('techwoman_runtime',oid,'EXECUTE') or has_function_privilege('techwoman_beatriz',oid,'EXECUTE') or has_function_privilege('techwoman_mailer',oid,'EXECUTE') reachable
  from pg_proc where pronamespace='internal'::regnamespace and proname=any($1) order by proname`,[names])).rows;
 assert.equal(rows.length,names.length);
 for(const r of rows){
  assert.equal(r.owner,'techwoman_owner',r.proname);assert.equal(r.proconfig[0],'search_path=pg_catalog, pg_temp',r.proname);
  assert.equal(r.granted,false,`${r.proname} sem EXECUTE concedido`);assert.equal(r.reachable,false,r.proname);
  if(r.proname!=='agenda_ranking')assert.equal(r.provolatile,'v',`${r.proname} VOLATILE`);
 }
 const triggers=(await db.query("select tgname from pg_trigger where tgrelid='public.enrollment'::regclass and not tgisinternal order by tgname")).rows.map(r=>r.tgname);
 assert.deepEqual(triggers,['agenda_enrollment_effects','agenda_enrollment_stamp','agenda_guard','agenda_row','agenda_row_immutable','agenda_validate','touch_version']);
}));
