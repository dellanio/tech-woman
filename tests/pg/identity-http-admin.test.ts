import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import * as email from '../../src/lib/email';
import * as login from '../../src/app/api/v1/auth/login/route';
import * as csrfRoute from '../../src/app/api/v1/auth/csrf/route';
import * as users from '../../src/app/api/v1/admin/users/route';
import * as user from '../../src/app/api/v1/admin/users/[id]/route';
import * as temporary from '../../src/app/api/v1/admin/users/[id]/temporary-password/route';
import {withDb,addUser,sessionFor,synthetic,participantRow,mentorRow,linkFixture,activeEnrollment} from './identity-harness.test';
import {call,code,sameShape,captureOutput,has,type Reply} from './identity-http-kit.test';

const LIST='/api/v1/admin/users';
const profile={goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true};
const mentorProfile={displayName:'Mentora Fictícia',trajectory:'Trajetória de teste',specialties:['produto'],availability:'Quartas',legacyCapacity:3,consent:true};
const csrfFor=async(token:string)=>String((await call(csrfRoute.GET,'/api/v1/auth/csrf',{cookie:token})).json.data.csrfToken);
type Actor={id:string;token:string;csrf:string};
const actorOf=async(db:Pool,roles:string[]):Promise<Actor>=>{const u=await addUser(db,{password:synthetic(),roles});const token=await sessionFor(db,u.id);return {id:u.id,token,csrf:await csrfFor(token)};};
const snap=async(db:Pool)=>JSON.stringify((await db.query(`select (select coalesce(jsonb_agg(to_jsonb(u) order by id),'[]') from app_user u) users,(select coalesce(jsonb_agg(to_jsonb(r) order by user_id,role),'[]') from user_role r) roles,(select coalesce(jsonb_agg(to_jsonb(j) order by id),'[]') from email_job j) jobs,(select coalesce(jsonb_agg(to_jsonb(s) order by id),'[]') from auth_session s) sessions,(select count(*)::int from audit_event) audits,(select count(*)::int from api_idempotency) idem`)).rows[0]);
const get=(a:Actor,id:string)=>call(user.GET,`${LIST}/${id}`,{cookie:a.token,params:{id}});
const patch=(a:Actor,id:string,body:unknown,version?:string,extra:Record<string,string|null>={})=>call(user.PATCH,`${LIST}/${id}`,{method:'PATCH',body,cookie:a.token,csrf:a.csrf,params:{id},headers:{...(version?{'If-Match':version}:{}),...extra}});
const del=(a:Actor,id:string,version?:string)=>call(user.DELETE,`${LIST}/${id}`,{method:'DELETE',cookie:a.token,csrf:a.csrf,params:{id},headers:version?{'If-Match':version}:{}});
const resend=(a:Actor,id:string,body:unknown={confirm:true},key:string|null=randomUUID())=>call(temporary.POST,`${LIST}/${id}/temporary-password`,{body,cookie:a.token,csrf:a.csrf,params:{id},...(key?{key}:{})});
const create=(a:Actor,body:unknown,key:string|null=randomUUID())=>call(users.POST,LIST,{body,cookie:a.token,csrf:a.csrf,...(key?{key}:{})});
const etagOf=(r:Reply)=>String(r.headers.get('etag')).replace(/"/g,'');

test('leitura HTTP: coleção paginada e GET por ID só de contas comuns; protegido/NULL privilegiado/inexistente → 404 idêntico; ETag; limitada e sem sessão negadas',async()=>withDb(async({db})=>{
 const {link}=await linkFixture(db);
 const admin=await actorOf(db,['admin']),team=await actorOf(db,['team']);
 const a=await addUser(db,{email:'a@example.invalid'}),b=await addUser(db,{email:'b@example.invalid',roles:['mentor']}),c=await addUser(db,{email:'c@example.invalid',status:'disabled',roles:[]});
 const multi=await addUser(db,{email:'multi@example.invalid',roles:['admin','mentor','participant']});await participantRow(db,10,'multi@example.invalid',multi.id);await mentorRow(db,20,'multi@example.invalid',multi.id);
 const pc=await addUser(db,{email:'pc@example.invalid'});await participantRow(db,31,'pc@example.invalid');await link('participant','31',null,'privileged_candidate');
 await participantRow(db,30,'null.candidate@example.invalid');await link('participant','30',null,'privileged_candidate');
 const ids=[a.id,b.id,c.id].sort();
 let r=await call(users.GET,LIST,{cookie:admin.token});
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(r.json.data.map((u:{id:string})=>u.id),ids);assert.deepEqual(r.json.page,{nextCursor:null});assert.match(r.json.requestId,/^[0-9a-f-]{36}$/);
 assert.deepEqual(Object.keys(r.json.data[0]).sort(),['email','id','roles','status','version']);assert.equal(r.text.includes('password'),false);assert.equal(r.headers.get('etag'),null,'lista não expõe ETag de usuário');
 r=await call(users.GET,`${LIST}?limit=2`,{cookie:admin.token});assert.deepEqual(r.json.data.map((u:{id:string})=>u.id),ids.slice(0,2));assert.equal(typeof r.json.page.nextCursor,'string');
 const next=await call(users.GET,`${LIST}?limit=2&cursor=${encodeURIComponent(r.json.page.nextCursor)}`,{cookie:admin.token});assert.deepEqual(next.json.data.map((u:{id:string})=>u.id),ids.slice(2));assert.equal(next.json.page.nextCursor,null);
 for(const query of ['limit=0','limit=101','limit=abc','cursor=lixo','limit=1&cursor='+Buffer.from('{"id":"x"}').toString('base64url')]){r=await call(users.GET,`${LIST}?${query}`,{cookie:admin.token});assert.deepEqual([query,r.status,code(r)],[query,422,'INVALID_INPUT']);}
 const one=await get(admin,a.id);assert.equal(one.status,200);assert.equal(one.headers.get('cache-control'),'no-store');
 assert.deepEqual(one.json.data,{id:a.id,email:'a@example.invalid',status:'active',roles:['participant'],version:etagOf(one)});assert.match(String(one.headers.get('etag')),/^"[1-9][0-9]*"$/);
 const hidden=[await get(admin,multi.id),await get(admin,pc.id),await get(admin,team.id),await get(admin,admin.id),await get(admin,randomUUID()),await get(admin,'bulk')];
 for(const h of hidden){assert.deepEqual([h.status,code(h)],[404,'NOT_FOUND']);assert.equal(sameShape(h,hidden[0]),true);assert.equal(h.headers.get('etag'),null);}
 assert.equal((await get(team,a.id)).status,200);assert.equal((await call(users.GET,LIST,{cookie:team.token})).status,200);
 const plain=await actorOf(db,['participant']);
 assert.deepEqual([(await call(users.GET,LIST,{cookie:plain.token})).status,code(await get(plain,a.id))],[403,'FORBIDDEN']);
 await db.query('update app_user set must_change_password=true where id=$1',[a.id]);const limited=await sessionFor(db,a.id,'password_change');
 assert.equal(code(await call(users.GET,LIST,{cookie:limited})),'PASSWORD_CHANGE_REQUIRED');assert.equal(code(await call(user.GET,`${LIST}/${a.id}`,{cookie:limited,params:{id:a.id}})),'PASSWORD_CHANGE_REQUIRED');
 assert.deepEqual([(await call(users.GET,LIST)).status,(await call(users.GET,LIST,{cookie:'z'.repeat(43)})).status],[401,401]);
}));

test('escrita HTTP: team 403; CSRF/Origin/Content-Type; If-Match 428/412; DTO fechado 422; protegido 404 sem mutação; corpo array/bulk recusado',async()=>withDb(async({db})=>{
 const admin=await actorOf(db,['admin']),team=await actorOf(db,['team']);
 const u=await addUser(db,{email:'alvo@example.invalid',password:synthetic()});const adm2=await addUser(db,{email:'adm2@example.invalid',roles:['admin','participant']});await participantRow(db,10,'adm2@example.invalid',adm2.id);
 const v=etagOf(await get(admin,u.id));
 const before=await snap(db);
 // team: leitura sim, escrita nunca
 for(const r of [await patch(team,u.id,{status:'disabled'},v),await del(team,u.id,v),await resend(team,u.id),await create(team,{email:'n@example.invalid',roles:['participant'],participant:profile})])assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 assert.equal(await snap(db),before,'team: zero mutação');
 // proteção de transporte
 let r=await call(user.PATCH,`${LIST}/${u.id}`,{method:'PATCH',body:{status:'disabled'},cookie:admin.token,params:{id:u.id},headers:{'If-Match':v}});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
 r=await patch(admin,u.id,{status:'disabled'},v,{Origin:null});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
 r=await patch(admin,u.id,{status:'disabled'},v,{'Content-Type':'text/plain'});assert.deepEqual([r.status,code(r)],[400,'INVALID_JSON']);
 r=await call(user.PATCH,`${LIST}/${u.id}`,{method:'PATCH',body:{status:'disabled'},cookie:admin.token,csrf:'x'.repeat(43),params:{id:u.id},headers:{'If-Match':v}});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
 // pré-condição
 r=await patch(admin,u.id,{status:'disabled'});assert.deepEqual([r.status,code(r)],[428,'PRECONDITION_REQUIRED']);
 r=await del(admin,u.id);assert.deepEqual([r.status,code(r)],[428,'PRECONDITION_REQUIRED']);
 r=await patch(admin,u.id,{status:'disabled'},'abc');assert.deepEqual([r.status,code(r)],[412,'VERSION_MISMATCH']);
 r=await patch(admin,u.id,{status:'disabled'},String(Number(v)+9));assert.deepEqual([r.status,code(r)],[412,'VERSION_MISMATCH']);
 r=await del(admin,u.id,'0');assert.deepEqual([r.status,code(r)],[412,'VERSION_MISMATCH']);
 // DTO fechado / sem mass assignment / sem bulk
 for(const body of [{},{role:'admin'},{id:randomUUID()},{password:'x'},{userId:'1'},{roles:['admin']},{roles:['team']},{email:'x@example.invalid',admin:true},[{status:'disabled'}],{status:'pending_activation'},{password_hash:'x'}]){
  r=await patch(admin,u.id,body,v);assert.deepEqual([JSON.stringify(body),r.status,code(r)],[JSON.stringify(body),422,'INVALID_INPUT']);
 }
 assert.equal(await snap(db),before,'recusas não mutam');
 // protegido e inexistente: 404 idêntico, zero mutação
 const probes=[await patch(admin,adm2.id,{status:'disabled'},'1'),await del(admin,adm2.id,'1'),await resend(admin,adm2.id),await patch(admin,randomUUID(),{status:'disabled'},'1'),await del(admin,'não-uuid','1'),await patch(admin,team.id,{roles:['mentor']},'1')];
 for(const p of probes){assert.deepEqual([p.status,code(p)],[404,'NOT_FOUND']);assert.equal(sameShape(p,probes[0]),true);}
 assert.equal(await snap(db),before);
 // sucesso: versão nova e ETag
 r=await patch(admin,u.id,{status:'disabled'},`"${v}"`);assert.equal(r.status,200);assert.equal(r.json.data.status,'disabled');assert.ok(Number(r.json.data.version)>Number(v));assert.equal(etagOf(r),r.json.data.version);
 r=await patch(admin,u.id,{status:'active'},v);assert.deepEqual([r.status,code(r)],[412,'VERSION_MISMATCH'],'versão antiga');
 r=await del(admin,u.id,r.json?.data?.version??etagOf(await get(admin,u.id)));assert.equal(r.status,200);assert.equal(r.json.data.status,'disabled');
 // coleção: corpo array e caminhos em lote
 r=await create(admin,[{email:'a@example.invalid'}]);assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);
 assert.deepEqual((await db.query("select action,changed_fields from audit_event order by id")).rows.map(x=>x.action),['user.update']);
}));

test('e-mail: troca revoga sessões e cancela jobs via HTTP; o worker lê o NOVO destino; destino indisponível → 409 genérico',async()=>withDb(async({db})=>{
 const admin=await actorOf(db,['admin']);const pw=synthetic();
 const u=await addUser(db,{email:'antigo@example.invalid',password:pw});const other=await addUser(db,{email:'ocupado@example.invalid'});await participantRow(db,5,'legado@example.invalid');
 const s=await sessionFor(db,u.id);const first=await resend(admin,u.id);assert.equal(first.status,202);
 const v=etagOf(await get(admin,u.id));
 const taken=[await patch(admin,u.id,{email:'OCUPADO@example.invalid'},v),await patch(admin,u.id,{email:'legado@example.invalid'},v)];
 for(const t of taken){assert.deepEqual([t.status,code(t)],[409,'EMAIL_UNAVAILABLE']);assert.equal(sameShape(t,taken[0]),true);}
 const ok=await patch(admin,u.id,{email:'Novo@Example.invalid'},v);assert.equal(ok.status,200);assert.deepEqual([ok.json.data.email,ok.json.data.status],['Novo@Example.invalid','pending_activation']);
 assert.equal((await call(login.POST,'/api/v1/auth/login',{body:{email:'novo@example.invalid',password:pw}})).status,401);
 const old=await db.query("select status from email_job where id=$1",[first.json.data.jobId]);assert.equal(old.rows[0].status,'cancelled','job do destino antigo cancelado');
 const messages:email.EmailMessage[]=[];await email.runEmailWorkerOnce(email.createMemoryTransport(m=>{messages.push(m);}));
 assert.deepEqual(messages.map(m=>[m.to,m.kind]),[['Novo@Example.invalid','temporary_password']],'uma única mensagem, para o destino novo');
 const via=await call(login.POST,'/api/v1/auth/login',{body:{email:'novo@example.invalid',password:messages[0].secret}});assert.deepEqual([via.status,via.json.data],[200,{state:'password_change_required'}]);
 assert.equal((await db.query('select 1 from auth_session where token_hash=$1 and revoked_at is null',[(await import('../../src/lib/db')).tokenDigest(s)])).rowCount,0);
 void other;
}));

test('criação HTTP: Idempotency-Key, roles = domínios, replay 201, corpo diferente 409, e-mail indisponível genérico, DTO fechado',async()=>withDb(async({db})=>{
 const {link}=await linkFixture(db);
 const admin=await actorOf(db,['admin']);await addUser(db,{email:'existe@example.invalid'});await participantRow(db,40,'legado@example.invalid');await link('admin_user','Priv@Example.invalid',null,'credential_conflict');
 const body={email:'Nova@Example.invalid',roles:['mentor','participant'],participant:profile,mentor:mentorProfile};const key=randomUUID();
 let r=await create(admin,body,key);assert.equal(r.status,201);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.deepEqual([r.json.data.email,r.json.data.status,r.json.data.roles],['Nova@Example.invalid','pending_activation',['mentor','participant']]);assert.equal(etagOf(r),r.json.data.version);
 const again=await create(admin,body,key);assert.deepEqual([again.status,again.json.data.id],[201,r.json.data.id]);
 assert.equal((await db.query("select count(*)::int n from app_user where email_key='nova@example.invalid'")).rows[0].n,1);
 r=await create(admin,{...body,email:'outra@example.invalid'},key);assert.deepEqual([r.status,code(r)],[409,'IDEMPOTENCY_CONFLICT']);
 r=await create(admin,body,null);assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);assert.ok(r.json.error.fields.includes('Idempotency-Key'));
 const clashes=[];for(const email of ['EXISTE@example.invalid','legado@example.invalid','priv@example.invalid','nova@example.invalid'])clashes.push(await create(admin,{email,roles:['participant'],participant:profile}));
 for(const c of clashes){assert.deepEqual([c.status,code(c)],[409,'EMAIL_UNAVAILABLE']);assert.equal(sameShape(c,clashes[0]),true);}
 for(const bad of [{email:'a@example.invalid',roles:['admin'],participant:profile},{email:'a@example.invalid',roles:['team']},{email:'a@example.invalid',roles:['participant']},{email:'a@example.invalid',roles:['mentor'],participant:profile},{email:'a@example.invalid',roles:['participant'],participant:{...profile,userId:'1'}},{email:'a@example.invalid',roles:['participant'],participant:profile,password:'x'},{email:'a@example.invalid',roles:[],},[],{}]){
  r=await create(admin,bad);assert.deepEqual([JSON.stringify(Object.keys(bad)),r.status,code(r)],[JSON.stringify(Object.keys(bad)),422,'INVALID_INPUT']);
 }
 assert.equal((await db.query("select count(*)::int n from user_role where role in ('admin','team')")).rows[0].n,1,'criação nunca concede admin/team');
}));

test('temporary-password HTTP: confirm:true, 202 {jobId,status}, idempotente por chave, não-admin ativo/pendente; worker em memória; sem segredo em resposta, tabelas ou logs',async()=>withDb(async({db})=>{
 const logs=captureOutput();const secrets:string[]=[];
 try{
  const admin=await actorOf(db,['admin']);secrets.push(admin.token,admin.csrf);const pw=synthetic();secrets.push(pw);
  const u=await addUser(db,{email:'pessoa@example.invalid',password:pw}),adm2=await addUser(db,{email:'adm2@example.invalid',password:synthetic(),roles:['admin']}),dis=await addUser(db,{email:'off@example.invalid',status:'disabled'});
  const k1=randomUUID();
  for(const body of [{},{confirm:false},{confirm:'true'},{confirm:true,extra:1},[true]]){const r=await resend(admin,u.id,body);assert.deepEqual([JSON.stringify(body),r.status,code(r)],[JSON.stringify(body),422,'INVALID_INPUT']);}
  let r=await resend(admin,u.id,{confirm:true},null);assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);assert.ok(r.json.error.fields.includes('Idempotency-Key'));
  r=await resend(admin,u.id,{confirm:true},'nao-uuid');assert.equal(r.status,422);
  const first=await resend(admin,u.id,{confirm:true},k1);assert.equal(first.status,202);assert.deepEqual(Object.keys(first.json.data).sort(),['jobId','status']);assert.equal(first.json.data.status,'queued');
  const again=await resend(admin,u.id,{confirm:true},k1);assert.deepEqual([again.status,again.json.data],[202,first.json.data]);
  assert.equal((await db.query("select count(*)::int n from email_job where kind='temporary_password'")).rows[0].n,1,'mesma chave não duplica job');
  const second=await resend(admin,u.id,{confirm:true},randomUUID());assert.notEqual(second.json.data.jobId,first.json.data.jobId);
  for(const target of [adm2.id,dis.id,admin.id,randomUUID()]){const p=await resend(admin,target);assert.deepEqual([p.status,code(p)],[404,'NOT_FOUND']);}
  // o worker emite só uma vez por usuária: a segunda intenção vira nova emissão; a senha chega apenas à memória do teste
  const messages:email.EmailMessage[]=[];await email.runEmailWorkerOnce(email.createMemoryTransport(m=>{messages.push(m);}));
  assert.ok(messages.length>=1);const temp=messages[messages.length-1].secret;secrets.push(temp);
  assert.equal(JSON.stringify([first.json,again.json,second.json]).includes(temp),false);
  const limited=await call(login.POST,'/api/v1/auth/login',{body:{email:u.email,password:temp}});assert.deepEqual([limited.status,limited.json.data],[200,{state:'password_change_required'}]);
  assert.equal((await call(login.POST,'/api/v1/auth/login',{body:{email:u.email,password:pw}})).status,401,'senha definitiva não vale enquanto a troca estiver pendente');
  logs.stop();
  const tables=(await db.query("select table_schema s,table_name t from information_schema.tables where table_schema in ('public','internal','legacy_snapshot') and table_type='BASE TABLE'")).rows;
  let leaked=false;for(const {s,t} of tables){if(has(JSON.stringify((await db.query(`select to_jsonb(x)::text j from ${s}.${t} x`)).rows),secrets))leaked=true;}
  assert.equal(leaked,false,'nenhum segredo em tabela');assert.equal(has(logs.text(),secrets),false,'nenhum segredo em log');
 }finally{logs.stop();}
}));
