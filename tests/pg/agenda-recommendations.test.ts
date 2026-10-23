import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as mentors from '../../src/app/api/v1/mentors/route';
import * as mentorOne from '../../src/app/api/v1/mentors/[mentorId]/route';
import * as mentorCohorts from '../../src/app/api/v1/mentors/[mentorId]/cohorts/route';
import * as recommendations from '../../src/app/api/v1/me/recommendations/route';
import * as enrollments from '../../src/app/api/v1/me/enrollments/route';
import * as enrollment from '../../src/app/api/v1/me/enrollments/[id]/route';
import {withDb,addTopic,addMentor,addParticipant,addMentorTopic,addCohort,mentorWithCohort,at} from './agenda-harness';
import {actorOf,participantActor,as,call,code,sameShape,snapshot,type Reply} from './agenda-api-kit';

type Choice={id:string;displayName:string;demo:boolean;trajectory:string;specialties:string[];score?:number;reasons?:string[]};
const choiceIds=(list:Choice[])=>list.map(c=>c.id);
/** Mentora elegível: ativa, tema ativo e turma open futura com vaga. */
async function eligible(db:Parameters<typeof addMentor>[0],specialties:string[],o:{from?:number;capacity?:number}={}){
 const mentor=await addMentor(db,{specialties});const t=await addTopic(db);const mt=await addMentorTopic(db,mentor,t);
 return {mentor,topic:t,mentorTopic:mt,cohort:await addCohort(db,mt,{from:o.from??0,capacity:o.capacity??5})};
}

test('catálogo e recomendações: ranking legado (objetivo+especialidade3, interesse2, habilidade1, área3), desempate por id, suggested score>0 e others score0 sem top3, só mentoras elegíveis, projeção sem e-mail/conta, paginação',()=>withDb(async({db})=>{
 const p=await participantActor(db,{goal:'growth',interests:['produto','dados'],skills:['analise'],area:'dados'});
 const A=await eligible(db,['dados']),B=await eligible(db,['produto'],{from:2}),C=await eligible(db,['design'],{from:4}),D=await eligible(db,['produto'],{from:6});
 // inelegíveis: só turma draft, turma lotada, mentora inativa, tema inativo, turma no passado
 const draft=await mentorWithCohort(db,{status:'draft',from:8});await db.query("update mentor set specialties='[\"dados\"]' where id=$1",[draft.mentor]);
 const full=await eligible(db,['dados'],{from:10,capacity:1});await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[await addParticipant(db),full.cohort]);
 const off=await eligible(db,['dados'],{from:12});await db.query('update mentor set active=false where id=$1',[off.mentor]);
 const topicOff=await eligible(db,['dados'],{from:14});await db.query('update topic set active=false where id=$1',[topicOff.topic]);
 const closed=await eligible(db,['dados'],{from:18});await db.query("update cohort set status='closed' where id=$1",[closed.cohort]);
 // mentora vinculada a conta admin aparece só pela projeção pública
 const boss=await actorOf(db,['admin','mentor'],{email:'chefe@example.invalid'});const E=await eligible(db,['design'],{from:16});
 await db.query("update mentor set user_id=$2,email='chefe@example.invalid',display_name=null where id=$1",[E.mentor,boss.id]);
 let r=await as(p).get(recommendations.GET,'/api/v1/me/recommendations');
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 const {suggested,others}=r.json.data as {suggested:Choice[];others:Choice[]};
 assert.deepEqual(choiceIds(suggested),[A.mentor,B.mentor,D.mentor],'score desc, empate por mentorId');
 assert.deepEqual(choiceIds(others),[C.mentor,E.mentor],'score0 continuam escolhíveis');
 assert.deepEqual(suggested.map(c=>c.score),[9,5,5]);assert.ok(others.every(c=>c.score===0&&Array.isArray(c.reasons)&&c.reasons.length===0));
 assert.deepEqual(suggested[0].reasons,['Área de atuação em comum: dados (+3)','Objetivo e especialidades: dados (+3)','Interesses em comum: dados (+2)','Habilidades relacionadas: analise (+1)']);
 assert.deepEqual(suggested[1].reasons,['Objetivo e especialidades: produto (+3)','Interesses em comum: produto (+2)']);
 assert.deepEqual(Object.keys(suggested[0]).sort(),['demo','displayName','id','reasons','score','specialties','trajectory']);
 const boss2=others.find(c=>c.id===E.mentor) as Choice;assert.equal(boss2.displayName,`Mentora #${E.mentor}`,'fallback sem e-mail');
 assert.equal(r.text.includes('@'),false,'nenhum e-mail na projeção');assert.equal(r.text.includes(boss.id),false,'nenhum userId');
 // paginação estável do ranking inteiro
 r=await as(p).get(recommendations.GET,'/api/v1/me/recommendations?limit=2');assert.deepEqual([choiceIds(r.json.data.suggested),choiceIds(r.json.data.others)],[[A.mentor,B.mentor],[]]);
 const next=r.json.page.nextCursor;assert.equal(typeof next,'string');
 r=await as(p).get(recommendations.GET,`/api/v1/me/recommendations?limit=2&cursor=${next}`);assert.deepEqual([choiceIds(r.json.data.suggested),choiceIds(r.json.data.others)],[[D.mentor],[C.mentor]]);
 r=await as(p).get(recommendations.GET,`/api/v1/me/recommendations?limit=2&cursor=${r.json.page.nextCursor}`);assert.deepEqual([choiceIds(r.json.data.suggested),choiceIds(r.json.data.others),r.json.page.nextCursor],[[],[E.mentor],null]);
 // catálogo /mentors?eligible=true e turmas: mesma elegibilidade, sem score
 const team=await actorOf(db,['team']),mentorUser=await actorOf(db,['mentor']),admin=await actorOf(db,['admin']);
 for(const who of [p,mentorUser,admin]){r=await as(who).get(mentors.GET,'/api/v1/mentors?eligible=true');assert.deepEqual(choiceIds(r.json.data),[A.mentor,B.mentor,C.mentor,D.mentor,E.mentor]);assert.equal(r.json.data[0].score,undefined);}
 r=await as(p).get(mentors.GET,'/api/v1/mentors?eligible=true&limit=3');assert.deepEqual(choiceIds(r.json.data),[A.mentor,B.mentor,C.mentor]);
 r=await as(p).get(mentors.GET,`/api/v1/mentors?eligible=true&limit=3&cursor=${r.json.page.nextCursor}`);assert.deepEqual([choiceIds(r.json.data),r.json.page.nextCursor],[[D.mentor,E.mentor],null]);
 r=await as(team).get(mentors.GET,'/api/v1/mentors?eligible=true');assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 r=await as(p).get(mentors.GET,'/api/v1/mentors');assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT'],'só a projeção elegível existe');
 r=await as(p).get(mentorOne.GET,`/api/v1/mentors/${A.mentor}`,{mentorId:A.mentor});assert.deepEqual(r.json.data,{id:A.mentor,displayName:'Mentora',demo:false,trajectory:'t',specialties:['dados']});
 for(const hidden of [draft.mentor,full.mentor,off.mentor,topicOff.mentor,closed.mentor,'999999']){const h=await as(p).get(mentorOne.GET,`/api/v1/mentors/${hidden}`,{mentorId:hidden});assert.deepEqual([hidden,h.status,code(h)],[hidden,404,'NOT_FOUND']);}
 const extra=await addCohort(db,A.mentorTopic,{from:20,capacity:2});await addCohort(db,A.mentorTopic,{from:22,status:'draft'});
 r=await as(p).get(mentorCohorts.GET,`/api/v1/mentors/${A.mentor}/cohorts`,{mentorId:A.mentor});
 assert.deepEqual(r.json.data.map((c:{id:string})=>c.id),[A.cohort,extra],'só open futuras');
 assert.deepEqual(Object.keys(r.json.data[0]).sort(),['available','capacity','endsAt','id','occupied','startsAt','timeZone','topic','version']);
 assert.equal(r.json.data[0].timeZone,'America/Recife');assert.match(r.json.data[0].startsAt,/Z$/);
 r=await as(p).get(mentorCohorts.GET,`/api/v1/mentors/${off.mentor}/cohorts`,{mentorId:off.mentor});assert.deepEqual([r.status,code(r)],[404,'NOT_FOUND']);
 // quem não é participante reconciliada não recebe recomendação
 r=await as(mentorUser).get(recommendations.GET,'/api/v1/me/recommendations');assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 const pending=await actorOf(db,['participant']);r=await as(pending).get(recommendations.GET,'/api/v1/me/recommendations');assert.deepEqual([r.status,code(r)],[409,'IDENTITY_RECONCILIATION_REQUIRED']);
 r=await call(recommendations.GET,'/api/v1/me/recommendations');assert.equal(r.status,401);
}));

test('reserva própria: score0 → turma → reserva sem aprovação (201), participantId nunca aceito, idempotência, vaga/duplicata/overlap/fechada 409, cancelar só a própria (idempotente), legacyMatches sem turma inventada, e-mail só intenção',()=>withDb(async({db})=>{
 const p=await participantActor(db,{goal:'growth',interests:['dados'],skills:['codigo'],area:'dados'});const P=as(p);
 const zero=await eligible(db,['design'],{capacity:1});
 let r=await P.get(recommendations.GET,'/api/v1/me/recommendations');assert.deepEqual([choiceIds(r.json.data.suggested),choiceIds(r.json.data.others)],[[],[zero.mentor]]);
 r=await P.get(mentorCohorts.GET,`/api/v1/mentors/${zero.mentor}/cohorts`,{mentorId:zero.mentor});const cohortId=r.json.data[0].id;
 const key=randomUUID();
 r=await P.send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId},key});
 assert.equal(r.status,201);assert.deepEqual(Object.keys(r.json.data).sort(),['cohortId','endsAt','id','startsAt','status']);
 assert.deepEqual([r.json.data.cohortId,r.json.data.status],[cohortId,'active']);assert.match(r.json.data.startsAt,/Z$/);
 const enrollmentId=r.json.data.id;
 const again=await P.send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId},key});assert.deepEqual([again.status,again.json.data.id],[201,enrollmentId],'replay não duplica');
 r=await P.send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId:zero.cohort==='1'?'2':'1'},key});assert.deepEqual([r.status,code(r)],[409,'IDEMPOTENCY_CONFLICT']);
 const match=(await db.query("select status,origin,score,reasons from match where enrollment_id=$1",[enrollmentId])).rows;
 assert.deepEqual(match,[{status:'selected',origin:'current',score:0,reasons:[]}],'score0 aceito sem aprovação humana');
 const jobs=(await db.query("select kind,status from email_job where enrollment_id=$1",[enrollmentId])).rows;assert.deepEqual(jobs,[{kind:'reservation',status:'queued'}],'intenção de e-mail, não entrega');
 assert.equal(JSON.stringify(r.json).includes('accepted'),false);
 const audit=(await db.query("select actor_user_id,action from audit_event where entity_type='enrollment'")).rows;assert.deepEqual(audit,[{actor_user_id:p.id,action:'enrollment.create'}],'auditoria única com ator da sessão');
 // participantId/status no corpo = mass assignment
 const other=await participantActor(db);
 for(const body of [{cohortId,participantId:other.participantId},{cohortId,status:'active'},{cohortId:Number(cohortId)},{},[{cohortId}]]){
  r=await as(other).send(enrollments.POST,'/api/v1/me/enrollments',{body,key:randomUUID()});assert.deepEqual([JSON.stringify(body),r.status,code(r)],[JSON.stringify(body),422,'INVALID_INPUT']);
 }
 r=await as(other).send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId}});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT'],'Idempotency-Key obrigatória');
 r=await as(other).send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId},key:randomUUID()});assert.deepEqual([r.status,code(r)],[409,'COHORT_FULL'],'última vaga já tomada');
 r=await P.send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId},key:randomUUID()});assert.deepEqual([r.status,code(r)],[409,'ALREADY_ENROLLED']);
 const near=await eligible(db,['dados'],{from:0});r=await P.send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId:near.cohort},key:randomUUID()});assert.deepEqual([r.status,code(r)],[409,'SCHEDULE_CONFLICT'],'overlap da participante entre mentoras');
 const later=await eligible(db,['dados'],{from:1});r=await P.send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId:later.cohort},key:randomUUID()});assert.equal(r.status,201,'contíguo vale');const second=r.json.data.id;
 const closed=await eligible(db,['dados'],{from:5});await db.query("update cohort set status='closed' where id=$1",[closed.cohort]);
 r=await P.send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId:closed.cohort},key:randomUUID()});assert.deepEqual([r.status,code(r)],[409,'COHORT_NOT_OPEN']);
 r=await P.send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId:'999999'},key:randomUUID()});assert.deepEqual([r.status,code(r),r.json.error.fields],[422,'INVALID_INPUT',['cohortId']]);
 // sem participante reconciliada / outros papéis
 const pending=await actorOf(db,['participant']);r=await as(pending).send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId:later.cohort},key:randomUUID()});assert.deepEqual([r.status,code(r)],[409,'IDENTITY_RECONCILIATION_REQUIRED']);
 const team=await actorOf(db,['team']);r=await as(team).send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId:later.cohort},key:randomUUID()});assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 r=await call(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId},cookie:p.token,key:randomUUID()});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
 // listagem própria + legado sem horário
 const legacyMentor=await addMentor(db);await db.query("insert into match(participant_id,mentor_id,score,reasons,status,origin) values($1,$2,4,'[]','approved','legacy')",[p.participantId,legacyMentor]);
 r=await P.get(enrollments.GET,'/api/v1/me/enrollments');
 assert.deepEqual(r.json.data.enrollments.map((e:{id:string;status:string})=>[e.id,e.status]),[[enrollmentId,'active'],[second,'active']]);
 assert.deepEqual(r.json.data.legacyMatches.map((m:Record<string,unknown>)=>({...m,id:'x'})),[{id:'x',mentorId:legacyMentor,status:'approved',origin:'legacy',enrollmentId:null}]);
 assert.equal(JSON.stringify(r.json.data.legacyMatches).includes('startsAt'),false,'sem horário inventado');
 r=await as(other).get(enrollments.GET,'/api/v1/me/enrollments');assert.deepEqual([r.json.data.enrollments,r.json.data.legacyMatches],[[],[]]);
 // cancelar: só a própria (outra → 404 sem mutação), idempotente, libera vaga só após commit
 const before=await snapshot(db);
 r=await as(other).send(enrollment.DELETE,`/api/v1/me/enrollments/${enrollmentId}`,{method:'DELETE',params:{id:enrollmentId}});
 const missing=await P.send(enrollment.DELETE,'/api/v1/me/enrollments/999999',{method:'DELETE',params:{id:'999999'}});
 assert.deepEqual([r.status,code(r)],[404,'NOT_FOUND']);assert.equal(sameShape(r,missing),true);assert.equal(await snapshot(db),before);
 r=await P.send(enrollment.DELETE,`/api/v1/me/enrollments/${enrollmentId}`,{method:'DELETE',params:{id:enrollmentId}});assert.deepEqual([r.status,r.json.data.status],[200,'cancelled']);
 r=await P.send(enrollment.DELETE,`/api/v1/me/enrollments/${enrollmentId}`,{method:'DELETE',params:{id:enrollmentId}});assert.deepEqual([r.status,r.json.data.status],[200,'cancelled'],'cancelamento idempotente');
 assert.deepEqual((await db.query("select m.status m,j.status j from match m join email_job j on j.enrollment_id=m.enrollment_id where m.enrollment_id=$1",[enrollmentId])).rows,[{m:'cancelled',j:'cancelled'}]);
 r=await as(other).send(enrollments.POST,'/api/v1/me/enrollments',{body:{cohortId},key:randomUUID()});assert.equal(r.status,201,'vaga liberada após o cancelamento');
 const actions=(await db.query("select actor_user_id,action from audit_event where entity_type='enrollment' order by id")).rows.map(a=>[a.actor_user_id,a.action]);
 assert.deepEqual(actions,[[p.id,'enrollment.create'],[p.id,'enrollment.create'],[p.id,'enrollment.cancel'],[other.id,'enrollment.create']]);
 void mentorWithCohort;void ({} as Reply);
}));
