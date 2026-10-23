/** Adaptadores antigos (CONTRATOS §7) sobre as operações SQL autorizadas: sem bypass de aprovação/reserva, protegidos 404 antes de qualquer ação. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {Pool} from 'pg';
import * as overview from '../../src/app/api/admin/overview/route';
import * as decide from '../../src/app/api/admin/decide/route';
import * as change from '../../src/app/api/admin/change/route';
import * as event from '../../src/app/api/admin/event/route';
import {sessionFor} from './identity-harness.test';
import {withDb,addParticipant,addMentor,linkFixture,mentorWithCohort} from './agenda-harness';
import {actorOf,as,call,code,snapshot,type Actor,type Reply} from './agenda-api-kit';

const O='/api/admin/overview',D='/api/admin/decide',C='/api/admin/change',E='/api/admin/event';
const post=(a:Actor,handler:Parameters<typeof call>[0],path:string,body:unknown,headers?:Record<string,string|null>)=>as(a).send(handler,path,{body,headers});
const legacyMatch=async(db:Pool,participant:string,mentor:string,status='approved')=>String((await db.query("insert into match(participant_id,mentor_id,score,reasons,status,origin) values($1,$2,3,'[\"legado\"]',$3,'legacy') returning id",[participant,mentor,status])).rows[0].id);
const demoMentor=async(db:Pool,o:{email?:string;userId?:string|null}={})=>String((await db.query("insert into mentor(email,trajectory,specialties,availability,capacity,active,demo,demo_name,user_id) values($1,'t','[\"dados\"]','a',2,true,true,'Demo',$2) returning id",[o.email??`demo-${Math.random().toString(16).slice(2)}@example.invalid`,o.userId??null])).rows[0].id);
const audits=async(db:Pool,entity:string)=>(await db.query('select actor_user_id,action,entity_id,changed_fields from audit_event where entity_type=$1 order by id',[entity])).rows;

/** Protegidos: admin multi-perfil vinculado, domínio com e-mail de admin sem vínculo e candidatos privilegiados com user_id NULL. */
async function fixtures(db:Pool){
 const {link}=await linkFixture(db);
 const multi=await actorOf(db,['admin','participant','mentor'],{email:'multi@example.invalid'});
 const pAdmin=await addParticipant(db,{userId:multi.id,email:'multi@example.invalid'}),mAdmin=await addMentor(db,{userId:multi.id,email:'multi@example.invalid',specialties:['dados']});
 const pSameEmail=await addParticipant(db,{userId:null,email:' MULTI@example.invalid'}),mSameEmail=await addMentor(db,{email:'Multi@Example.invalid',specialties:['dados']});
 const pCandidate=await addParticipant(db,{userId:null,email:'candidata@example.invalid'});await link('participant',pCandidate,null,'privileged_candidate');
 const mCandidate=await addMentor(db,{email:'cand-m@example.invalid',specialties:['dados']});await link('mentor',mCandidate,null,'privileged_candidate');
 const participant=await addParticipant(db,{userId:null,email:'legada@example.invalid'}),mentor=await addMentor(db,{email:'m-comum@example.invalid',specialties:['dados']});
 return {link,multi,participant,mentor,hiddenParticipants:[pAdmin,pSameEmail,pCandidate],hiddenMentors:[mAdmin,mSameEmail,mCandidate]};
}

test('overview: sessão full admin/team revalidada no banco, protegidos (vinculado, e-mail de admin, candidato NULL) fora de participantes/mentoras/sugestões; demais 401/403',()=>withDb(async({db})=>{
 const f=await fixtures(db);const admin=await actorOf(db,['admin']),team=await actorOf(db,['team']),plain=await actorOf(db,['participant','mentor']);
 await legacyMatch(db,f.participant,f.hiddenMentors[0]);
 for(const who of [admin,team]){
  const r=await as(who).get(overview.GET,O);
  assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(Object.keys(r.json).sort(),['mentors','participants']);
  assert.deepEqual(r.json.participants.map((p:{id:string})=>p.id),[f.participant]);
  assert.deepEqual(r.json.mentors.map((m:{id:string})=>m.id),[f.mentor]);
  const person=r.json.participants[0];
  assert.deepEqual(person.choices.map((c:{mentorId:string})=>c.mentorId),[f.mentor],'sugestão nunca aponta mentora protegida');
  assert.equal(person.approvedMentorId,null,'vínculo legado com mentora protegida é omitido');
  assert.equal(person.protocol,`TW-${f.participant.padStart(5,'0')}`);
  assert.equal(JSON.stringify(r.json).includes('multi@'),false);assert.equal(JSON.stringify(r.json).toLowerCase().includes('cand'),false);
 }
 let r=await as(plain).get(overview.GET,O);assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 r=await call(overview.GET,O);assert.deepEqual([r.status,code(r)],[401,'AUTH_REQUIRED']);
 const limited=await sessionFor(db,admin.id,'password_change');r=await call(overview.GET,O,{cookie:limited});assert.deepEqual([r.status,code(r)],[403,'PASSWORD_CHANGE_REQUIRED']);
 await db.query("update app_user set status='disabled' where id=$1",[team.id]);
 r=await as(team).get(overview.GET,O);assert.deepEqual([r.status,code(r)],[401,'AUTH_REQUIRED'],'ator desativado perde acesso no ato');
}));

test('decide: approve sem turma → 422 com instrução do fluxo novo (protegido/inexistente 404 antes); reject só sugestão current sem reserva, com auditoria do ator; DTO fechado/CSRF/Content-Type',()=>withDb(async({db})=>{
 const f=await fixtures(db);const admin=await actorOf(db,['admin']),team=await actorOf(db,['team']);const A=(body:unknown,headers?:Record<string,string|null>)=>post(admin,decide.POST,D,body,headers);
 const before=await snapshot(db);
 let r=await A({participantId:f.participant,mentorId:f.mentor,action:'approve'});
 assert.deepEqual([r.status,code(r),r.json.error.fields],[422,'INVALID_INPUT',['cohortId']]);assert.match(r.json.error.message,/\/api\/v1\/me\/enrollments/);
 r=await A({participantId:Number(f.participant),mentorId:Number(f.mentor),action:'approve'});assert.deepEqual([r.status,r.json.error.fields],[422,['cohortId']],'IDs numéricos antigos aceitos e normalizados');
 const hidden:Reply[]=[];
 for(const p of [...f.hiddenParticipants,'999999'])hidden.push(await A({participantId:p,mentorId:f.mentor,action:'approve'}),await A({participantId:p,mentorId:f.mentor,action:'reject'}));
 for(const m of [...f.hiddenMentors,'999999'])hidden.push(await A({participantId:f.participant,mentorId:m,action:'approve'}),await A({participantId:f.participant,mentorId:m,action:'reject'}));
 for(const h of hidden)assert.deepEqual([h.status,code(h)],[404,'NOT_FOUND']);
 for(const bad of [{participantId:f.participant,mentorId:f.mentor,action:'approve',role:'admin'},{participantId:f.participant,mentorId:f.mentor,action:'approve',cohortId:'1'},{participantId:f.participant,mentorId:f.mentor,action:'select'},
  {participantId:f.participant,action:'reject'},{participantId:'0',mentorId:f.mentor,action:'reject'},{participantId:'abc',mentorId:f.mentor,action:'reject'},[{participantId:f.participant,mentorId:f.mentor,action:'reject'}]])
  {r=await A(bad);assert.deepEqual([JSON.stringify(bad),r.status,code(r)],[JSON.stringify(bad),422,'INVALID_INPUT']);}
 r=await post(team,decide.POST,D,{participantId:f.participant,mentorId:f.mentor,action:'reject'});assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 r=await A({participantId:f.participant,mentorId:f.mentor,action:'reject'},{'X-CSRF-Token':null});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
 r=await A({participantId:f.participant,mentorId:f.mentor,action:'reject'},{'Content-Type':'text/plain'});assert.deepEqual([r.status,code(r)],[400,'INVALID_JSON']);
 assert.equal(await snapshot(db),before,'nenhuma recusa altera dados');
 // reject da sugestão calculada (sem match): registra a rejeição current, score do servidor
 r=await A({participantId:f.participant,mentorId:f.mentor,action:'reject'});assert.deepEqual([r.status,r.json],[200,{status:'Sugestão rejeitada'}]);
 const rejected=(await db.query("select id::text,status,origin,enrollment_id,score from match where participant_id=$1 and mentor_id=$2",[f.participant,f.mentor])).rows;
 const ranked=(await db.query('select (internal.agenda_ranking($1,$2)).o_score s',[f.participant,f.mentor])).rows[0].s;
 assert.deepEqual(rejected.map(x=>[x.status,x.origin,x.enrollment_id,x.score]),[['rejected','current',null,ranked]]);
 r=await A({participantId:f.participant,mentorId:f.mentor,action:'reject'});assert.deepEqual([r.status,code(r),r.json.error.fields],[422,'INVALID_INPUT',['status']],'já revisada');
 // sugestão current existente → rejected (mesma linha); legado aprovado e seleção com reserva nunca mudam por decide
 const other=await addParticipant(db,{userId:null});
 const suggested=String((await db.query("insert into match(participant_id,mentor_id,score,reasons,status,origin) values($1,$2,2,'[]','suggested','current') returning id",[other,f.mentor])).rows[0].id);
 r=await A({participantId:other,mentorId:f.mentor,action:'reject'});assert.equal(r.status,200);
 assert.deepEqual((await db.query('select status,version::int v from match where id=$1',[suggested])).rows[0],{status:'rejected',v:2});
 const third=await addParticipant(db,{userId:null});const legacy=await legacyMatch(db,third,f.mentor);
 const agenda=await mentorWithCohort(db);const enrolled=await addParticipant(db);await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[enrolled,agenda.cohort]);
 const frozen=await snapshot(db);
 for(const [p,m] of [[third,f.mentor],[enrolled,agenda.mentor]]){r=await A({participantId:p,mentorId:m,action:'reject'});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);r=await A({participantId:p,mentorId:m,action:'approve'});assert.equal(r.status,422);}
 assert.equal(await snapshot(db),frozen);assert.equal((await db.query('select status from match where id=$1',[legacy])).rows[0].status,'approved');
 assert.deepEqual((await audits(db,'match')).map(a=>[a.actor_user_id,a.action,a.changed_fields]),[[admin.id,'match.reject',['status']],[admin.id,'match.reject',['status']]]);
}));

test('change: cancel preserva histórico legado (cancelled + auditoria); reassign sem turma 422 após checagem de protegido; ativar/desativar soft com reserva 409; remove-demo transacional sem protegidos e sem parcial',()=>withDb(async({db})=>{
 const f=await fixtures(db);const admin=await actorOf(db,['admin']),team=await actorOf(db,['team']);const A=(body:unknown,headers?:Record<string,string|null>)=>post(admin,change.POST,C,body,headers);
 const legacy=await legacyMatch(db,f.participant,f.mentor);
 const hiddenLegacy=await legacyMatch(db,f.hiddenParticipants[1],f.mentor);const viaHiddenMentor=await addParticipant(db,{userId:null});await legacyMatch(db,viaHiddenMentor,f.hiddenMentors[2]);
 const before=await snapshot(db);
 for(const body of [...f.hiddenParticipants.map(p=>({action:'cancel',participantId:p})),{action:'cancel',participantId:viaHiddenMentor},{action:'cancel',participantId:'999999'},
  ...f.hiddenParticipants.map(p=>({action:'reassign',participantId:p,mentorId:f.mentor})),...f.hiddenMentors.map(m=>({action:'reassign',participantId:f.participant,mentorId:m})),
  ...f.hiddenMentors.map(m=>({action:'deactivate',mentorId:m})),...f.hiddenMentors.map(m=>({action:'activate',mentorId:m})),{action:'deactivate',mentorId:'999999'}]){
  const r=await A(body);assert.deepEqual([JSON.stringify(body),r.status,code(r)],[JSON.stringify(body),404,'NOT_FOUND']);
 }
 let r=await A({action:'reassign',participantId:f.participant,mentorId:f.mentor});
 assert.deepEqual([r.status,code(r),r.json.error.fields],[422,'INVALID_INPUT',['cohortId']]);assert.match(r.json.error.message,/\/api\/v1\/admin\/enrollments/);
 for(const bad of [{action:'reassign',participantId:f.participant,mentorId:f.mentor,cohortId:'1'},{action:'cancel',participantId:f.participant,mentorId:f.mentor,extra:1},{action:'remove-demo',mentorId:f.mentor},{action:'delete',participantId:f.participant},{action:'activate'},{}])
  {r=await A(bad);assert.deepEqual([JSON.stringify(bad),r.status,code(r)],[JSON.stringify(bad),422,'INVALID_INPUT']);}
 for(const body of [{action:'cancel',participantId:f.participant},{action:'remove-demo'},{action:'deactivate',mentorId:f.mentor}]){r=await post(team,change.POST,C,body);assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);}
 r=await A({action:'cancel',participantId:f.participant},{'X-CSRF-Token':'x'});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
 assert.equal(await snapshot(db),before,'recusas sem mutação');
 // cancel do par legado: mesma linha, status cancelled, score/FKs/razões preservados, auditoria com ator
 const original=(await db.query('select participant_id,mentor_id,score,reasons,origin,enrollment_id from match where id=$1',[legacy])).rows[0];
 r=await A({action:'cancel',participantId:f.participant});assert.deepEqual([r.status,r.json],[200,{status:'Reserva cancelada'}]);
 assert.deepEqual((await db.query('select participant_id,mentor_id,score,reasons,origin,enrollment_id,status from match where id=$1',[legacy])).rows[0],{...original,status:'cancelled'});
 assert.equal((await db.query('select status from match where id=$1',[hiddenLegacy])).rows[0].status,'approved');
 r=await A({action:'cancel',participantId:f.participant});assert.deepEqual([r.status,code(r),r.json.error.fields],[422,'INVALID_INPUT',['participantId']],'nada mais para cancelar');
 // ativar/desativar (soft) e reserva ativa → 409 sem mutação
 r=await A({action:'deactivate',mentorId:Number(f.mentor)});assert.deepEqual([r.status,r.json],[200,{status:'Mentora desativada'}]);
 r=await A({action:'activate',mentorId:f.mentor});assert.deepEqual([r.status,r.json],[200,{status:'Mentora ativada'}]);
 assert.equal((await db.query('select active from mentor where id=$1',[f.mentor])).rows[0].active,true);
 const agenda=await mentorWithCohort(db);await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[await addParticipant(db),agenda.cohort]);
 const busy=await snapshot(db);r=await A({action:'deactivate',mentorId:agenda.mentor});assert.deepEqual([r.status,code(r)],[409,'COHORT_IN_USE']);assert.equal(await snapshot(db),busy);
 // remove-demo: só demo ativa não protegida; reserva ativa de uma derruba o conjunto inteiro
 const free=await demoMentor(db),guarded=await demoMentor(db,{email:'multi@example.invalid'}),linked=await demoMentor(db);await f.link('mentor',linked,null,'privileged_candidate');
 const busyDemo=await demoMentor(db);const {cohort:demoCohort}=await (async()=>{const t=String((await db.query("insert into topic(slug,name) values('demo-t','Demo') returning id")).rows[0].id);
  const mt=String((await db.query('insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,1) returning id',[busyDemo,t])).rows[0].id);
  return {cohort:String((await db.query("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,now()+interval '40 days',now()+interval '40 days 1 hour',3,'open') returning id",[mt])).rows[0].id)};})();
 const demoEnrollment=String((await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id",[await addParticipant(db),demoCohort])).rows[0].id);
 const withBusy=await snapshot(db);r=await A({action:'remove-demo'});assert.deepEqual([r.status,code(r)],[409,'COHORT_IN_USE']);assert.equal(await snapshot(db),withBusy,'sem desativação parcial');
 await db.query("update enrollment set status='cancelled' where id=$1",[demoEnrollment]);
 r=await A({action:'remove-demo'});assert.deepEqual([r.status,r.json],[200,{status:'2 mentoras de demonstração desativadas.'}]);
 assert.deepEqual((await db.query('select id::text,active from mentor where demo order by id')).rows,[{id:free,active:false},{id:guarded,active:true},{id:linked,active:true},{id:busyDemo,active:false}]);
 const mentorAudit=await audits(db,'mentor');
 assert.deepEqual(mentorAudit.map(a=>[a.actor_user_id,a.action,a.entity_id]),[[admin.id,'mentor.deactivate',f.mentor],[admin.id,'mentor.activate',f.mentor],[admin.id,'mentor.remove_demo',free],[admin.id,'mentor.remove_demo',busyDemo]]);
 assert.deepEqual((await audits(db,'match')).map(a=>[a.actor_user_id,a.action,a.entity_id]),[[admin.id,'match.cancel',legacy]]);
}));

test('event: GET admin/team com sessão full, PUT só admin com CSRF, DTO fechado de seis textos e auditoria; anônimo 401',()=>withDb(async({db})=>{
 const admin=await actorOf(db,['admin']),team=await actorOf(db,['team']);
 let r=await as(team).get(event.GET,E);assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.deepEqual(Object.keys(r.json).sort(),['agenda','date','description','duration','speakers','venue']);
 r=await call(event.GET,E);assert.deepEqual([r.status,code(r)],[401,'AUTH_REQUIRED']);
 const body={description:'Encontro sintético',venue:'Recife sintético',agenda:'Texto do evento',speakers:'',date:'2026-11-14',duration:'4h'};
 r=await as(team).send(event.PUT,E,{method:'PUT',body});assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 r=await as(admin).send(event.PUT,E,{method:'PUT',body,headers:{'X-CSRF-Token':null}});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
 for(const bad of [{...body,extra:'x'},{...body,date:'2026-02-30'},{...body,venue:'x'.repeat(1501)},{...body,agenda:3},(({duration:_d,...rest})=>rest)(body),[body]]){
  r=await as(admin).send(event.PUT,E,{method:'PUT',body:bad});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);
 }
 assert.equal((await db.query('select count(*)::int n from audit_event')).rows[0].n,0);
 r=await as(admin).send(event.PUT,E,{method:'PUT',body:{...body,venue:'  Recife sintético  '}});assert.deepEqual([r.status,r.json],[200,body]);
 r=await as(team).get(event.GET,E);assert.deepEqual(r.json,body);
 assert.deepEqual((await audits(db,'event_content')).map(a=>[a.actor_user_id,a.action,a.entity_id]),[[admin.id,'event.update','1']]);
}));
