import {test} from 'node:test';
import assert from 'node:assert/strict';
import {withDb,withClients,addUser,addTopic,addMentor,addParticipant,addMentorTopic,addCohort,EDITOR} from './agenda-harness';

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
