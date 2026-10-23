import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import * as topics from '../../src/app/api/v1/topics/route';
import * as topic from '../../src/app/api/v1/topics/[id]/route';
import {withDb,addTopic,addParticipant,mentorWithCohort} from './agenda-harness';
import {actorOf,as,call,code,etagOf,snapshot,type Reply} from './agenda-api-kit';

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
