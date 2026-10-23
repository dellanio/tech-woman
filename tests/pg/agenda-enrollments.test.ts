import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withDb,withClients,addUser,addTopic,addMentor,addParticipant,addMentorTopic,addCohort,startedCohort,pgFails,EDITOR} from './agenda-harness';

test('reserva SQL da editora: match current selected com score/reasons do ranking legado (score0 aceito), job reservation e auditoria sem dados pessoais', ()=>withDb(async ({db,url})=>{
 const user=await addUser(db,{roles:['participant']}),other=await addUser(db,{roles:['participant']});
 const participant=await addParticipant(db,{userId:user.id,email:user.email}),zero=await addParticipant(db,{userId:other.id,email:other.email,goal:'leadership',interests:['design'],skills:['gestao'],area:null});
 const mentor=await addMentor(db,{specialties:['dados','desenvolvimento']}),cohort=await addCohort(db,await addMentorTopic(db,mentor,await addTopic(db)),{from:0});
 const ids=await withClients(url,[EDITOR],async b=>Promise.all([participant,zero].map(async p=>(await b.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id::text",[p,cohort])).rows[0].id as string)));
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
 await withClients(url,[EDITOR],async b=>{
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
