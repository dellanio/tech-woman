import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as topics from '../../src/app/api/v1/topics/route';
import * as topic from '../../src/app/api/v1/topics/[id]/route';
import * as mentorTopics from '../../src/app/api/v1/mentors/[mentorId]/topics/route';
import * as reorder from '../../src/app/api/v1/mentors/[mentorId]/topics/reorder/route';
import * as mentorTopic from '../../src/app/api/v1/mentor-topics/[id]/route';
import * as cohorts from '../../src/app/api/v1/mentor-topics/[id]/cohorts/route';
import * as cohort from '../../src/app/api/v1/cohorts/[id]/route';
import {withDb,addTopic,addMentor,addMentorTopic,addParticipant,addCohort,mentorWithCohort,at} from './agenda-harness';
import {actorOf,mentorActor,as,call,code,etagOf,snapshot,sameShape,type Reply} from './agenda-api-kit';

const ids=(r:Reply)=>r.json.data.map((x:{id:string})=>x.id);

test('topics: envelope/ETag, admin cria com Idempotency-Key (replay e corpo divergente), DTO fechado, catálogo lê só ativos, PATCH/DELETE com If-Match, team/participant sem escrita, auditoria com ator',()=>withDb(async({db})=>{
 const admin=await actorOf(db,['admin']),team=await actorOf(db,['team']),participant=await actorOf(db,['participant']),none=await actorOf(db,[]);
 const A=as(admin);const key=randomUUID();const body={slug:'carreira-dados',name:'Carreira em dados',description:'Primeiros passos'};
 let r=await A.send(topics.POST,'/api/v1/topics',{body,key});
 assert.equal(r.status,201);assert.equal(r.headers.get('cache-control'),'no-store');assert.match(r.json.requestId,/^[0-9a-f-]{36}$/);
 assert.deepEqual(Object.keys(r.json.data).sort(),['active','description','id','name','slug','version']);
 assert.match(r.json.data.id,/^[1-9][0-9]*$/);assert.equal(etagOf(r),r.json.data.version);
 const id=r.json.data.id;
 const again=await A.send(topics.POST,'/api/v1/topics',{body:{name:'Carreira em dados',slug:'carreira-dados',description:'Primeiros passos'},key});
 assert.deepEqual([again.status,again.json.data.id],[201,id],'mesma chave+corpo canônico → mesmo recurso');
 r=await A.send(topics.POST,'/api/v1/topics',{body:{...body,name:'Outro'},key});assert.deepEqual([r.status,code(r)],[409,'IDEMPOTENCY_CONFLICT']);
 r=await A.send(topics.POST,'/api/v1/topics',{body});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);assert.ok(r.json.error.fields.includes('Idempotency-Key'));
 for(const bad of [{slug:'Com Espaço',name:'x'},{slug:'a',name:''},{slug:'a',name:'x',active:false},{slug:'a',name:'x',id:'9'},[body]])
  {r=await A.send(topics.POST,'/api/v1/topics',{body:bad,key:randomUUID()});assert.deepEqual([JSON.stringify(bad),r.status,code(r)],[JSON.stringify(bad),422,'INVALID_INPUT']);}
 r=await A.send(topics.POST,'/api/v1/topics',{body:{slug:'carreira-dados',name:'Repetido'},key:randomUUID()});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT'],'slug repetido');assert.deepEqual(r.json.error.fields,['slug']);
 assert.equal((await db.query('select count(*)::int n from topic')).rows[0].n,1);
 // escrita negada sem mutação
 const before=await snapshot(db);
 for(const who of [team,participant,none]){r=await as(who).send(topics.POST,'/api/v1/topics',{body:{slug:'x',name:'x'},key:randomUUID()});assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);}
 r=await call(topics.POST,'/api/v1/topics',{body:{slug:'x',name:'x'},cookie:admin.token,key:randomUUID()});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED'],'sem X-CSRF-Token');
 r=await A.send(topics.POST,'/api/v1/topics',{body:{slug:'x',name:'x'},key:randomUUID(),headers:{Origin:'http://evil.example.invalid'}});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
 r=await call(topics.POST,'/api/v1/topics',{raw:'{',cookie:admin.token,csrf:admin.csrf,key:randomUUID()});assert.deepEqual([r.status,code(r)],[400,'INVALID_JSON']);
 r=await call(topics.GET,'/api/v1/topics');assert.deepEqual([r.status,code(r)],[401,'AUTH_REQUIRED']);
 assert.equal(await snapshot(db),before);
 // catálogo: inativo só para admin/team; cursor bigint opaco
 const inactive=await addTopic(db,{active:false});const third=await addTopic(db);
 r=await as(participant).get(topics.GET,'/api/v1/topics');assert.deepEqual(ids(r),[id,third]);assert.equal(r.headers.get('etag'),null);assert.deepEqual(r.json.page,{nextCursor:null});
 r=await as(team).get(topics.GET,'/api/v1/topics?limit=2');assert.deepEqual(ids(r),[id,inactive]);assert.equal(typeof r.json.page.nextCursor,'string');
 r=await as(team).get(topics.GET,`/api/v1/topics?limit=2&cursor=${r.json.page.nextCursor}`);assert.deepEqual([ids(r),r.json.page.nextCursor],[[third],null]);
 for(const q of ['limit=0','limit=101','limit=x','cursor=lixo','cursor='+Buffer.from('{"id":"abc"}').toString('base64url')]){r=await A.get(topics.GET,`/api/v1/topics?${q}`);assert.deepEqual([q,r.status,code(r)],[q,422,'INVALID_INPUT']);}
 r=await as(none).get(topics.GET,'/api/v1/topics');assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN'],'sem perfil não lê catálogo');
 // GET por ID
 r=await as(participant).get(topic.GET,`/api/v1/topics/${id}`,{id});assert.equal(r.status,200);assert.equal(etagOf(r),r.json.data.version);
 for(const probe of [inactive,'999999','abc','0']){r=await as(participant).get(topic.GET,`/api/v1/topics/${probe}`,{id:probe});assert.deepEqual([probe,r.status,code(r)],[probe,404,'NOT_FOUND']);}
 assert.equal((await as(team).get(topic.GET,`/api/v1/topics/${inactive}`,{id:inactive})).status,200);
 // PATCH com If-Match
 const v=etagOf(await A.get(topic.GET,`/api/v1/topics/${id}`,{id}));
 r=await A.send(topic.PATCH,`/api/v1/topics/${id}`,{method:'PATCH',body:{name:'Novo nome'},params:{id}});assert.deepEqual([r.status,code(r)],[428,'PRECONDITION_REQUIRED']);
 r=await A.send(topic.PATCH,`/api/v1/topics/${id}`,{method:'PATCH',body:{name:'Novo nome'},params:{id},version:String(Number(v)+5)});assert.deepEqual([r.status,code(r)],[412,'VERSION_MISMATCH']);
 for(const bad of [{slug:'outro'},{},{name:'x',version:'9'},{active:'false'}]){r=await A.send(topic.PATCH,`/api/v1/topics/${id}`,{method:'PATCH',body:bad,params:{id},version:v});assert.deepEqual([JSON.stringify(bad),r.status,code(r)],[JSON.stringify(bad),422,'INVALID_INPUT']);}
 r=await as(team).send(topic.PATCH,`/api/v1/topics/${id}`,{method:'PATCH',body:{name:'x'},params:{id},version:v});assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 r=await A.send(topic.PATCH,`/api/v1/topics/${id}`,{method:'PATCH',body:{name:'Novo nome'},params:{id},version:`"${v}"`});
 assert.equal(r.status,200);assert.deepEqual([r.json.data.name,r.json.data.slug],['Novo nome','carreira-dados']);assert.ok(Number(r.json.data.version)>Number(v));assert.equal(etagOf(r),r.json.data.version);
 r=await A.send(topic.PATCH,`/api/v1/topics/${id}`,{method:'PATCH',body:{name:'De novo'},params:{id},version:v});assert.deepEqual([r.status,code(r)],[412,'VERSION_MISMATCH'],'versão antiga');
 r=await A.send(topic.PATCH,'/api/v1/topics/999999',{method:'PATCH',body:{name:'x'},params:{id:'999999'},version:'1'});assert.deepEqual([r.status,code(r)],[404,'NOT_FOUND']);
 // DELETE desativa; tema em uso por reserva ativa → 409
 const used=await mentorWithCohort(db);const p=await addParticipant(db);await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[p,used.cohort]);
 const uv=etagOf(await A.get(topic.GET,`/api/v1/topics/${used.topic}`,{id:used.topic}));
 r=await A.send(topic.DELETE,`/api/v1/topics/${used.topic}`,{method:'DELETE',params:{id:used.topic},version:uv});assert.deepEqual([r.status,code(r)],[409,'COHORT_IN_USE']);
 assert.equal(r.text.includes('agenda_'),false,'sem nome SQL cru');
 r=await A.send(topic.DELETE,`/api/v1/topics/${third}`,{method:'DELETE',params:{id:third}});assert.deepEqual([r.status,code(r)],[428,'PRECONDITION_REQUIRED']);
 r=await A.send(topic.DELETE,`/api/v1/topics/${third}`,{method:'DELETE',params:{id:third},version:'1'});assert.deepEqual([r.status,r.json.data.active],[200,false]);
 assert.equal((await db.query('select active from topic where id=$1',[third])).rows[0].active,false,'soft delete');
 // auditoria: ator confiável (sessão), só nomes de campos
 const audit=(await db.query("select actor_user_id,action,entity_id,changed_fields from audit_event where entity_type='topic' order by id")).rows;
 assert.deepEqual(audit.map(a=>[a.actor_user_id,a.action,a.entity_id]),[[admin.id,'topic.create',id],[admin.id,'topic.update',id],[admin.id,'topic.deactivate',third]]);
 assert.deepEqual(audit[1].changed_fields,['name']);
}));

test('mentor topics: mentora própria e admin escrevem (Idempotency-Key), team só lê, outra mentora/participante 404; limite 2/repetição 409; reorder atômico; PATCH/DELETE com If-Match; mentora protegida oculta ao admin',()=>withDb(async({db})=>{
 const admin=await actorOf(db,['admin']),team=await actorOf(db,['team']),participant=await actorOf(db,['participant']);
 const own=await mentorActor(db),other=await mentorActor(db);const t1=await addTopic(db),t2=await addTopic(db),t3=await addTopic(db),off=await addTopic(db,{active:false});
 const M=own.mentorId,base=`/api/v1/mentors/${M}/topics`;const O=as(own);const params={mentorId:M};
 const key=randomUUID();
 let r=await O.send(mentorTopics.POST,base,{body:{topicId:t1,position:1},params,key});
 assert.equal(r.status,201);assert.deepEqual(Object.keys(r.json.data).sort(),['id','mentorId','position','topicId','version']);
 assert.deepEqual([r.json.data.mentorId,r.json.data.topicId,r.json.data.position],[M,t1,1]);assert.equal(etagOf(r),r.json.data.version);const l1=r.json.data.id;
 r=await O.send(mentorTopics.POST,base,{body:{position:1,topicId:t1},params,key});assert.deepEqual([r.status,r.json.data.id],[201,l1],'replay');
 r=await O.send(mentorTopics.POST,base,{body:{topicId:t2,position:1},params,key});assert.deepEqual([r.status,code(r)],[409,'IDEMPOTENCY_CONFLICT']);
 r=await as(admin).send(mentorTopics.POST,base,{body:{topicId:t2,position:2},params,key:randomUUID()});assert.equal(r.status,201,'admin agenda o domínio');const l2=r.json.data.id;
 for(const body of [{topicId:t3,position:1},{topicId:t1,position:2}]){r=await O.send(mentorTopics.POST,base,{body,params,key:randomUUID()});assert.deepEqual([JSON.stringify(body),r.status,code(r)],[JSON.stringify(body),409,'TOPIC_LIMIT']);}
 const solo=await mentorActor(db);
 for(const body of [{topicId:off,position:1},{topicId:'999999',position:1},{topicId:t1,position:3},{topicId:7,position:1},{topicId:t1,position:1,mentorId:M},{topicId:t1}]){
  r=await as(solo).send(mentorTopics.POST,`/api/v1/mentors/${solo.mentorId}/topics`,{body,params:{mentorId:solo.mentorId},key:randomUUID()});assert.deepEqual([JSON.stringify(body),r.status,code(r)],[JSON.stringify(body),422,'INVALID_INPUT']);
 }
 const before=await snapshot(db);
 const denied=[await as(other).send(mentorTopics.POST,base,{body:{topicId:t3,position:1},params,key:randomUUID()}),await as(participant).send(mentorTopics.POST,base,{body:{topicId:t3,position:1},params,key:randomUUID()}),
  await as(other).get(mentorTopics.GET,base,params),await as(participant).get(mentorTopics.GET,base,params),await O.get(mentorTopics.GET,'/api/v1/mentors/999999/topics',{mentorId:'999999'}),
  await as(other).get(mentorTopic.GET,`/api/v1/mentor-topics/${l1}`,{id:l1}),await as(other).send(mentorTopic.DELETE,`/api/v1/mentor-topics/${l1}`,{method:'DELETE',params:{id:l1},version:'1'}),
  await as(other).send(reorder.POST,`${base}/reorder`,{body:{firstId:l2,secondId:l1},params})];
 for(const d of denied){assert.deepEqual([d.status,code(d)],[404,'NOT_FOUND']);assert.equal(sameShape(d,denied[0]),true);}
 r=await as(team).send(mentorTopics.POST,base,{body:{topicId:t3,position:1},params,key:randomUUID()});assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 assert.equal(await snapshot(db),before,'recusas sem mutação');
 for(const who of [own,admin,team]){r=await as(who).get(mentorTopics.GET,base,params);assert.deepEqual(r.json.data.map((x:{id:string;position:number})=>[x.id,x.position]),[[l1,1],[l2,2]]);assert.deepEqual(r.json.page,{nextCursor:null});}
 // reorder: só os dois vínculos da própria mentora, posições finais 1/2, sem terceiro temporário
 for(const body of [{firstId:l1,secondId:l1},{firstId:l1,secondId:'999999'},{firstId:l2},{firstId:l2,secondId:l1,position:1}]){r=await O.send(reorder.POST,`${base}/reorder`,{body,params});assert.deepEqual([JSON.stringify(body),r.status,code(r)],[JSON.stringify(body),422,'INVALID_INPUT']);}
 r=await O.send(reorder.POST,`${base}/reorder`,{body:{firstId:l2,secondId:l1},params});
 assert.equal(r.status,200);assert.deepEqual(r.json.data.map((x:{id:string;position:number})=>[x.id,x.position]),[[l2,1],[l1,2]]);
 assert.equal((await db.query('select count(*)::int n from mentor_topic where mentor_id=$1',[M])).rows[0].n,2);
 r=await as(solo).send(reorder.POST,`/api/v1/mentors/${solo.mentorId}/topics/reorder`,{body:{firstId:l1,secondId:l2},params:{mentorId:solo.mentorId}});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT'],'vínculos de outra mentora');
 // GET/PATCH/DELETE por id
 r=await O.get(mentorTopic.GET,`/api/v1/mentor-topics/${l1}`,{id:l1});assert.deepEqual([r.status,r.json.data.position],[200,2]);const v1=etagOf(r);
 r=await O.send(mentorTopic.PATCH,`/api/v1/mentor-topics/${l1}`,{method:'PATCH',body:{position:1},params:{id:l1},version:v1});assert.deepEqual([r.status,code(r)],[409,'TOPIC_LIMIT'],'posição ocupada: troca só via reorder');
 for(const bad of [{topicId:t3},{mentorId:solo.mentorId},{position:3},{}]){r=await O.send(mentorTopic.PATCH,`/api/v1/mentor-topics/${l1}`,{method:'PATCH',body:bad,params:{id:l1},version:v1});assert.deepEqual([JSON.stringify(bad),r.status,code(r)],[JSON.stringify(bad),422,'INVALID_INPUT']);}
 r=await O.send(mentorTopic.PATCH,`/api/v1/mentor-topics/${l1}`,{method:'PATCH',body:{position:2},params:{id:l1}});assert.deepEqual([r.status,code(r)],[428,'PRECONDITION_REQUIRED']);
 await addCohort(db,l2);const v2=etagOf(await O.get(mentorTopic.GET,`/api/v1/mentor-topics/${l2}`,{id:l2}));
 r=await O.send(mentorTopic.DELETE,`/api/v1/mentor-topics/${l2}`,{method:'DELETE',params:{id:l2},version:v2});assert.deepEqual([r.status,code(r)],[409,'COHORT_IN_USE'],'turma referencia o vínculo');
 r=await O.send(mentorTopic.DELETE,`/api/v1/mentor-topics/${l1}`,{method:'DELETE',params:{id:l1},version:String(Number(v1)+3)});assert.deepEqual([r.status,code(r)],[412,'VERSION_MISMATCH']);
 r=await as(team).send(mentorTopic.DELETE,`/api/v1/mentor-topics/${l1}`,{method:'DELETE',params:{id:l1},version:v1});assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 r=await O.send(mentorTopic.DELETE,`/api/v1/mentor-topics/${l1}`,{method:'DELETE',params:{id:l1},version:v1});assert.equal(r.status,204);
 r=await O.send(mentorTopic.PATCH,`/api/v1/mentor-topics/${l2}`,{method:'PATCH',body:{position:2},params:{id:l2},version:v2});assert.deepEqual([r.status,r.json.data.position],[200,2]);
 // mentora vinculada a conta admin: ela mesma gere a própria agenda; o CRUD comum de outro admin não a enxerga
 const boss=await mentorActor(db,{roles:['admin','mentor']});const bossBase=`/api/v1/mentors/${boss.mentorId}/topics`;
 r=await as(boss).send(mentorTopics.POST,bossBase,{body:{topicId:t1,position:1},params:{mentorId:boss.mentorId},key:randomUUID()});assert.equal(r.status,201);const bl=r.json.data.id;
 const hidden=[await as(admin).get(mentorTopics.GET,bossBase,{mentorId:boss.mentorId}),await as(team).get(mentorTopic.GET,`/api/v1/mentor-topics/${bl}`,{id:bl}),
  await as(admin).send(mentorTopics.POST,bossBase,{body:{topicId:t2,position:2},params:{mentorId:boss.mentorId},key:randomUUID()}),
  await as(admin).send(mentorTopic.DELETE,`/api/v1/mentor-topics/${bl}`,{method:'DELETE',params:{id:bl},version:'1'})];
 for(const h of hidden)assert.deepEqual([h.status,code(h)],[404,'NOT_FOUND']);
 const audit=(await db.query("select actor_user_id,action from audit_event where entity_type='mentor_topic' order by id")).rows.map(a=>[a.actor_user_id,a.action]);
 assert.deepEqual(audit,[[own.id,'mentor_topic.create'],[admin.id,'mentor_topic.create'],[own.id,'mentor_topic.reorder'],[own.id,'mentor_topic.delete'],[own.id,'mentor_topic.update'],[boss.id,'mentor_topic.create']]);
 void addMentor;
}));

/** Mesmo instante escrito com offset de Recife (-03:00), como o contrato exige na entrada. */
const recife=(iso:string)=>new Date(Date.parse(iso)-3*3600e3).toISOString().slice(0,19)+'-03:00';
test('cohorts: offset obrigatório e saída UTC Z/America/Recife, ocupação/vagas, overlap da mentora entre temas 409 e contíguo ok, transições do DER, mudança de horário/capacidade com reservas 409, DELETE cancela sem reservas',()=>withDb(async({db})=>{
 const own=await mentorActor(db),team=await actorOf(db,['team']),participant=await actorOf(db,['participant']),other=await mentorActor(db);
 const t1=await addTopic(db),t2=await addTopic(db);const mt1=await addMentorTopic(db,own.mentorId,t1,1),mt2=await addMentorTopic(db,own.mentorId,t2,2);
 const O=as(own);const path=`/api/v1/mentor-topics/${mt1}/cohorts`;const key=randomUUID();
 const body={startsAt:recife(at(10)),endsAt:recife(at(11)),capacity:20,status:'open'};
 let r=await O.send(cohorts.POST,path,{body,params:{id:mt1},key});
 assert.equal(r.status,201);
 assert.deepEqual(r.json.data,{id:r.json.data.id,mentorTopicId:mt1,topic:{id:t1,name:'Tema'},startsAt:at(10).replace('.000Z','Z'),endsAt:at(11).replace('.000Z','Z'),timeZone:'America/Recife',capacity:20,occupied:0,available:20,status:'open',version:r.json.data.version});
 const c1=r.json.data.id;assert.equal(etagOf(r),r.json.data.version);
 r=await O.send(cohorts.POST,path,{body,params:{id:mt1},key});assert.deepEqual([r.status,r.json.data.id],[201,c1],'replay');
 for(const bad of [{...body,startsAt:at(10).slice(0,16)},{...body,startsAt:'2026-11-14T09:00:00'},{...body,capacity:21},{...body,capacity:0},{...body,endsAt:body.startsAt},{...body,status:'closed'},{...body,mentorTopicId:mt2},{...body,occupied:0}]){
  r=await O.send(cohorts.POST,path,{body:bad,params:{id:mt1},key:randomUUID()});assert.deepEqual([JSON.stringify(bad),r.status,code(r)],[JSON.stringify(bad),422,'INVALID_INPUT']);
 }
 const past=new Date(Date.now()-3600e3).toISOString();r=await O.send(cohorts.POST,path,{body:{...body,startsAt:past,endsAt:at(1)},params:{id:mt1},key:randomUUID()});assert.deepEqual([r.status,code(r),r.json.error.fields],[422,'INVALID_INPUT',['startsAt']],'início no passado');
 r=await O.send(cohorts.POST,`/api/v1/mentor-topics/${mt2}/cohorts`,{body:{...body,startsAt:at(10.5),endsAt:at(12)},params:{id:mt2},key:randomUUID()});assert.deepEqual([r.status,code(r)],[409,'SCHEDULE_CONFLICT'],'overlap entre temas da mesma mentora');
 r=await O.send(cohorts.POST,`/api/v1/mentor-topics/${mt2}/cohorts`,{body:{startsAt:at(11),endsAt:at(12),capacity:1,status:'draft'},params:{id:mt2},key:randomUUID()});assert.equal(r.status,201,'contíguo é válido');const c2=r.json.data.id;
 r=await as(other).send(cohorts.POST,path,{body,params:{id:mt1},key:randomUUID()});assert.deepEqual([r.status,code(r)],[404,'NOT_FOUND']);
 r=await as(team).send(cohorts.POST,path,{body,params:{id:mt1},key:randomUUID()});assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 // leitura
 r=await as(team).get(cohorts.GET,`${path}?limit=1`,{id:mt1});assert.deepEqual([r.json.data.map((c:{id:string})=>c.id),r.json.page.nextCursor],[[c1],null]);
 for(const probe of [await as(participant).get(cohort.GET,`/api/v1/cohorts/${c1}`,{id:c1}),await as(other).get(cohort.GET,`/api/v1/cohorts/${c1}`,{id:c1}),await as(participant).get(cohorts.GET,path,{id:mt1}),await O.get(cohort.GET,'/api/v1/cohorts/999999',{id:'999999'})])
  assert.deepEqual([probe.status,code(probe)],[404,'NOT_FOUND']);
 // reservas: ocupação, capacidade e horário travados, cancelamento exige zero ativas
 const p1=await addParticipant(db),p2=await addParticipant(db);
 for(const p of [p1,p2])await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[p,c1]);
 r=await O.get(cohort.GET,`/api/v1/cohorts/${c1}`,{id:c1});assert.deepEqual([r.json.data.occupied,r.json.data.available],[2,18]);let v=etagOf(r);
 const patch=(b:unknown,version=v)=>O.send(cohort.PATCH,`/api/v1/cohorts/${c1}`,{method:'PATCH',body:b,params:{id:c1},version});
 r=await patch({capacity:1});assert.deepEqual([r.status,code(r)],[409,'COHORT_IN_USE'],'capacidade abaixo da ocupação');
 r=await patch({startsAt:recife(at(20)),endsAt:recife(at(21))});assert.deepEqual([r.status,code(r)],[409,'COHORT_IN_USE'],'horário com inscritas');
 r=await patch({status:'draft'});assert.deepEqual([r.status,code(r),r.json.error.fields],[422,'INVALID_INPUT',['status']]);
 r=await patch({capacity:2});assert.equal(r.status,200);v=etagOf(r);assert.deepEqual([r.json.data.capacity,r.json.data.available],[2,0]);
 r=await patch({status:'closed'});assert.deepEqual([r.status,r.json.data.status],[200,'closed']);v=etagOf(r);
 r=await patch({status:'open'});assert.deepEqual([r.status,r.json.data.status],[200,'open'],'closed→open futura');v=etagOf(r);
 r=await patch({capacity:3},'1');assert.deepEqual([r.status,code(r)],[412,'VERSION_MISMATCH']);
 r=await O.send(cohort.PATCH,`/api/v1/cohorts/${c1}`,{method:'PATCH',body:{capacity:3},params:{id:c1}});assert.deepEqual([r.status,code(r)],[428,'PRECONDITION_REQUIRED']);
 for(const bad of [{mentorTopicId:mt2},{occupied:1},{startsAt:'2026-11-14T09:00:00'},{}]){r=await patch(bad);assert.deepEqual([JSON.stringify(bad),r.status,code(r)],[JSON.stringify(bad),422,'INVALID_INPUT']);}
 r=await O.send(cohort.DELETE,`/api/v1/cohorts/${c1}`,{method:'DELETE',params:{id:c1},version:v});assert.deepEqual([r.status,code(r)],[409,'COHORT_IN_USE'],'cancelar com inscritas ativas');
 r=await as(team).send(cohort.DELETE,`/api/v1/cohorts/${c2}`,{method:'DELETE',params:{id:c2},version:'1'});assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 r=await O.send(cohort.DELETE,`/api/v1/cohorts/${c2}`,{method:'DELETE',params:{id:c2},version:'1'});assert.deepEqual([r.status,r.json.data.status],[200,'cancelled']);
 r=await O.send(cohort.PATCH,`/api/v1/cohorts/${c2}`,{method:'PATCH',body:{status:'open'},params:{id:c2},version:r.json.data.version});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT'],'cancelada não reabre');
 r=await O.send(cohorts.POST,`/api/v1/mentor-topics/${mt2}/cohorts`,{body:{startsAt:at(11),endsAt:at(12),capacity:5,status:'open'},params:{id:mt2},key:randomUUID()});assert.equal(r.status,201,'cancelada libera o horário');
 const audit=(await db.query("select actor_user_id,action,changed_fields from audit_event where entity_type='cohort' order by id")).rows;
 assert.deepEqual(audit.map(a=>a.action),['cohort.create','cohort.create','cohort.update','cohort.update','cohort.update','cohort.cancel','cohort.create']);
 assert.ok(audit.every(a=>a.actor_user_id===own.id));assert.deepEqual(audit[2].changed_fields,['capacity']);
 void mentorWithCohort;void addMentor;
}));
