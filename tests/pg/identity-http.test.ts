import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {closeDb} from '../../src/lib/db';
import * as login from '../../src/app/api/v1/auth/login/route';
import * as forgot from '../../src/app/api/v1/auth/password/forgot/route';
import * as reset from '../../src/app/api/v1/auth/password/reset/route';
import * as participants from '../../src/app/api/v1/registrations/participants/route';
import * as mentors from '../../src/app/api/v1/registrations/mentors/route';
import {withDb,addUser,synthetic,roleUrl} from './identity-harness.test';
import {call,code,sameShape,type Reply} from './identity-http-kit.test';

const participantDto=(email:string,extra:Record<string,unknown>={})=>({email,goal:'transition',moment:'starting',interests:['dados'],skills:['analise'],area:'dados',consent:true,...extra});
const mentorDto=(email:string,extra:Record<string,unknown>={})=>({email,displayName:'Mentora Fictícia',trajectory:'Trajetória de teste',specialties:['produto'],availability:'Quartas',legacyCapacity:3,consent:true,...extra});
const LOGIN='/api/v1/auth/login',FORGOT='/api/v1/auth/password/forgot',RESET='/api/v1/auth/password/reset',REG_P='/api/v1/registrations/participants',REG_M='/api/v1/registrations/mentors';
const tryLogin=(email:string,password='errada-errada-1',headers:Record<string,string|null>={})=>call(login.POST,LOGIN,{body:{email,password},headers});
const register=(email:string,extra:Record<string,unknown>={})=>call(participants.POST,REG_P,{body:participantDto(email,extra),key:randomUUID()});
const counts=async(db:Pool)=>(await db.query(`select (select count(*)::int from app_user) users,(select count(*)::int from email_job) jobs,(select count(*)::int from participant) participants,(select count(*)::int from mentor) mentors`)).rows[0];

test('contrato comum: Origin/Sec-Fetch-Site, Content-Type, JSON, DTO fechado e envelope de erro com no-store',async()=>withDb(async()=>{
 const key=randomUUID();
 const routes:[string,typeof login.POST,string,Record<string,unknown>][]=[
  ['login',login.POST,LOGIN,{email:'a@example.invalid',password:'x'}],['forgot',forgot.POST,FORGOT,{email:'a@example.invalid'}],
  ['reset',reset.POST,RESET,{token:'t',newPassword:'uma-senha-longa-1'}],['participants',participants.POST,REG_P,participantDto('a@example.invalid')],['mentors',mentors.POST,REG_M,mentorDto('a@example.invalid')],
 ];
 const envelope=(r:Reply)=>{assert.equal(r.headers.get('cache-control'),'no-store');assert.match(String(r.json.requestId),/^[0-9a-f-]{36}$/);assert.deepEqual(Object.keys(r.json.error).sort(),['code','fields','message']);assert.ok(Array.isArray(r.json.error.fields));assert.equal(/stack|select |insert |at \w+\./i.test(r.text),false);};
 for(const [name,handler,path,body] of routes){
  const opts={body,key};
  let r=await call(handler,path,{...opts,headers:{Origin:null}});assert.deepEqual([name,r.status,code(r)],[name,403,'CSRF_REJECTED']);envelope(r);
  r=await call(handler,path,{...opts,headers:{Origin:'http://evil.example.invalid'}});assert.deepEqual([name,r.status,code(r)],[name,403,'CSRF_REJECTED']);
  r=await call(handler,path,{...opts,headers:{'Sec-Fetch-Site':'cross-site'}});assert.deepEqual([name,r.status,code(r)],[name,403,'CSRF_REJECTED']);
  r=await call(handler,path,{...opts,headers:{'Content-Type':'text/plain'}});assert.deepEqual([name,r.status,code(r)],[name,400,'INVALID_JSON']);envelope(r);
  r=await call(handler,path,{raw:'{"email":',key});assert.deepEqual([name,r.status,code(r)],[name,400,'INVALID_JSON']);
  r=await call(handler,path,{...opts,body:{...body,injected:'admin'}});assert.deepEqual([name,r.status,code(r)],[name,422,'INVALID_INPUT']);assert.ok(r.json.error.fields.includes('injected'));envelope(r);
  r=await call(handler,path,{...opts,body:[body]});assert.deepEqual([name,r.status,code(r)],[name,422,'INVALID_INPUT']);
  r=await call(handler,path,{...opts,body:{}});assert.deepEqual([name,r.status,code(r)],[name,422,'INVALID_INPUT']);
 }
 for(const extra of [{role:'admin'},{userId:'1'},{roles:['admin']}]){
  const r=await call(participants.POST,REG_P,{body:participantDto('mass@example.invalid',extra),key});assert.equal(r.status,422,'mass assignment recusado');
 }
}));

test('limites no PG: login 5/min por par e 30/min por IP, também para desconhecidos, compartilhado entre pools, 429 com Retry-After',async()=>withDb(async()=>{
 for(let i=1;i<=3;i++){const r=await tryLogin('Limite@Example.invalid');assert.deepEqual([i,r.status,code(r)],[i,401,'INVALID_CREDENTIALS']);}
 await closeDb();
 for(let i=4;i<=5;i++){const r=await tryLogin(' limite@example.INVALID ');assert.deepEqual([i,r.status,code(r)],[i,401,'INVALID_CREDENTIALS']);}
 await closeDb();
 const blocked=await tryLogin('limite@example.invalid');
 assert.deepEqual([blocked.status,code(blocked)],[429,'RATE_LIMITED']);assert.equal(blocked.headers.get('cache-control'),'no-store');
 const retry=Number(blocked.headers.get('retry-after'));assert.ok(Number.isInteger(retry)&&retry>=1&&retry<=60,'Retry-After em segundos');
 assert.equal((await tryLogin('outro@example.invalid')).status,401,'outro par não é afetado');
 assert.equal((await call(login.POST,LOGIN,{body:{email:'limite@example.invalid',password:'certa-certa-12345'}})).status,429,'senha correta também é contada');
}));

test('limites no PG: IP 30/min no login; forgot e cadastro 3/h por e-mail+ação e 20/h por IP; reset 10/min por IP',async()=>withDb(async({db})=>{
 for(let i=1;i<=30;i++){const r=await tryLogin(`ip${i}@example.invalid`);assert.equal(r.status,401,`tentativa ${i}`);}
 const ipBlocked=await tryLogin('ip31@example.invalid');assert.deepEqual([ipBlocked.status,code(ipBlocked)],[429,'RATE_LIMITED']);
 await db.query('truncate auth_rate_bucket');
 for(let i=1;i<=3;i++)assert.equal((await call(forgot.POST,FORGOT,{body:{email:'Ninguem@Example.invalid'}})).status,202);
 const fourth=await call(forgot.POST,FORGOT,{body:{email:' ninguem@example.invalid'}});assert.deepEqual([fourth.status,code(fourth)],[429,'RATE_LIMITED']);assert.ok(Number(fourth.headers.get('retry-after'))>=1);
 assert.equal((await call(forgot.POST,FORGOT,{body:{email:'outro@example.invalid'}})).status,202);
 for(let i=1;i<=3;i++)assert.equal((await register('mesma@example.invalid')).status,202);
 assert.equal((await register('MESMA@example.invalid')).status,429);
 assert.equal((await call(mentors.POST,REG_M,{body:mentorDto('mesma@example.invalid'),key:randomUUID()})).status,202,'ação diferente tem balde próprio');
 await db.query('truncate auth_rate_bucket');
 for(let i=1;i<=20;i++)assert.equal((await call(forgot.POST,FORGOT,{body:{email:`ip${i}@example.invalid`}})).status,202,`forgot ${i}`);
 assert.equal((await call(forgot.POST,FORGOT,{body:{email:'ip21@example.invalid'}})).status,429,'20/h por IP');
 await db.query('truncate auth_rate_bucket');
 for(let i=1;i<=10;i++){const r=await call(reset.POST,RESET,{body:{token:`token-invalido-${i}`,newPassword:'uma-senha-longa-1'}});assert.deepEqual([i,r.status,code(r)],[i,400,'INVALID_RESET']);}
 const eleventh=await call(reset.POST,RESET,{body:{token:'token-invalido-11',newPassword:'uma-senha-longa-1'}});assert.deepEqual([eleventh.status,code(eleventh)],[429,'RATE_LIMITED']);
}));

test('limites configuráveis sem desativar; IP só do último X-Forwarded-For com TRUST_PROXY=1; baldes não guardam e-mail/IP brutos',async()=>withDb(async({db})=>{
 for(let i=1;i<=2;i++)assert.equal((await tryLogin('cfg@example.invalid')).status,401);
 assert.equal((await tryLogin('cfg@example.invalid')).status,429,'RATE_LOGIN_PAIR_PER_MIN=2');
 await db.query('truncate auth_rate_bucket');
 Reflect.set(process.env,'RATE_LOGIN_PAIR_PER_MIN','0');
 for(let i=1;i<=5;i++)assert.equal((await tryLogin('zero@example.invalid')).status,401);
 assert.equal((await tryLogin('zero@example.invalid')).status,429,'valor inválido/zero volta ao padrão 5, nunca desativa');
 await db.query('truncate auth_rate_bucket');Reflect.set(process.env,'RATE_LOGIN_PAIR_PER_MIN','5');
 // sem TRUST_PROXY, X-Forwarded-For arbitrário é ignorado: o par continua o mesmo
 for(let i=1;i<=5;i++)assert.equal((await tryLogin('xff@example.invalid','errada-errada-1',{'X-Forwarded-For':`198.51.100.${i}`})).status,401);
 assert.equal((await tryLogin('xff@example.invalid','errada-errada-1',{'X-Forwarded-For':'203.0.113.99'})).status,429);
 await db.query('truncate auth_rate_bucket');
 Reflect.set(process.env,'TRUST_PROXY','1');
 for(let i=1;i<=5;i++)assert.equal((await tryLogin('xff@example.invalid','errada-errada-1',{'X-Forwarded-For':`198.51.100.250, 10.0.0.1`})).status,401);
 assert.equal((await tryLogin('xff@example.invalid','errada-errada-1',{'X-Forwarded-For':'198.51.100.250, 10.0.0.1'})).status,429);
 assert.equal((await tryLogin('xff@example.invalid','errada-errada-1',{'X-Forwarded-For':'198.51.100.250, 10.0.0.2'})).status,401,'último salto diferente = outro balde');
 assert.equal((await tryLogin('xff@example.invalid','errada-errada-1',{'X-Forwarded-For':'lixo, não-é-ip'})).status,401,'IP inválido cai no balde compartilhado');
 const buckets=JSON.stringify((await db.query('select * from auth_rate_bucket')).rows);
 for(const raw of ['xff@example.invalid','10.0.0.1','10.0.0.2','198.51.100.250'])assert.equal(buckets.includes(raw),false,'balde sem dado bruto');
 assert.equal((await db.query("select count(*)::int n from auth_rate_bucket where bucket_key !~ '^[A-Za-z0-9_-]{43}$'")).rows[0].n,0,'HMAC-SHA256 em base64url');
},{RATE_LOGIN_PAIR_PER_MIN:'2'}));

test('rate_hit é atômico entre pools, tem janela fixa e expira',async()=>withDb(async({db,url})=>{
 const a=new Pool({connectionString:roleUrl(url,'techwoman_runtime'),max:5}),b=new Pool({connectionString:roleUrl(url,'techwoman_runtime'),max:5});
 try{
  const hits=await Promise.all(Array.from({length:40},(_,i)=>(i%2?a:b).query('select * from internal.rate_hit($1,$2,$3)',['K'.repeat(43),5,60])));
  const rows=hits.map(h=>h.rows[0]);
  assert.equal(rows.filter(r=>r.o_allowed===true).length,5,'exatamente o limite passa, mesmo concorrente em dois pools');
  assert.equal(rows.every(r=>r.o_allowed===true||(r.o_retry>=1&&r.o_retry<=60)),true);
  await db.query("update auth_rate_bucket set expires_at=now()-interval '1 second' where bucket_key=$1",['K'.repeat(43)]);
  const fresh=(await a.query('select * from internal.rate_hit($1,$2,$3)',['K'.repeat(43),5,60])).rows[0];assert.equal(fresh.o_allowed,true);
  assert.equal((await db.query('select count from auth_rate_bucket where bucket_key=$1',['K'.repeat(43)])).rows[0].count,1,'nova janela recomeça em 1');
 }finally{await a.end();await b.end();}
}));

test('anti-enumeração: forgot, cadastro e login são indistinguíveis para inexistente, ativa, pendente, desativada e admin',async()=>withDb(async({db})=>{
 const pw=synthetic();
 const active=await addUser(db,{email:'ativa@example.invalid',password:pw}),pending=await addUser(db,{email:'pendente@example.invalid',status:'pending_activation'});
 const disabled=await addUser(db,{email:'off@example.invalid',password:pw,status:'disabled'}),admin=await addUser(db,{email:'adm@example.invalid',password:pw,roles:['admin','mentor']});
 const emails=[active.email,pending.email,disabled.email,admin.email,'inexistente@example.invalid'];
 const forgots=[];for(const email of emails)forgots.push(await call(forgot.POST,FORGOT,{body:{email}}));
 assert.deepEqual(forgots.map(r=>r.status),Array(5).fill(202));assert.deepEqual(forgots[0].json.data,{status:'received'});
 for(const r of forgots)assert.equal(sameShape(r,forgots[0]),true);
 const registrations=[];for(const email of emails)registrations.push(await register(email));
 assert.deepEqual(registrations.map(r=>r.status),Array(5).fill(202));assert.deepEqual(registrations[0].json.data,{status:'received',next:'check_email'});
 for(const r of registrations)assert.equal(sameShape(r,registrations[0]),true);
 const mentorRegs=[];for(const email of emails)mentorRegs.push(await call(mentors.POST,REG_M,{body:mentorDto(email),key:randomUUID()}));
 for(const r of mentorRegs)assert.equal(sameShape(r,registrations[0]),true);
 const attempts=[];for(const email of emails)attempts.push(await tryLogin(email,pw+'-errada'));
 attempts.push(await tryLogin(disabled.email,pw));
 for(const r of attempts){assert.equal(r.status,401);assert.equal(sameShape(r,attempts[0]),true);assert.equal(r.headers.get('set-cookie'),null);}
 assert.equal((await db.query("select count(*)::int n from user_role where role in ('admin','team')")).rows[0].n,1,'cadastro público nunca concede perfil privilegiado');
 assert.equal((await db.query("select count(*)::int n from app_user where email_key=lower($1)",[admin.email])).rows[0].n,1);
 assert.equal((await db.query("select count(*)::int n from participant where user_id=$1 or user_id=$2",[admin.id,disabled.id])).rows[0].n,0);
}));

test('idempotência do cadastro público: chave UUID obrigatória, mesmo corpo repete 202 sem duplicar, corpo diferente 409, nada sensível no cache',async()=>withDb(async({db})=>{
 for(const key of [undefined,'nao-uuid','1234']){
  const r=await call(participants.POST,REG_P,{body:participantDto('k@example.invalid'),...(key?{key}:{})});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);assert.ok(r.json.error.fields.includes('Idempotency-Key'));
 }
 assert.deepEqual(await counts(db),{users:0,jobs:0,participants:0,mentors:0});
 const key=randomUUID();const body=participantDto('Chave@Example.invalid');
 const first=await call(participants.POST,REG_P,{body,key}),second=await call(participants.POST,REG_P,{body,key:key.toUpperCase()});
 assert.deepEqual([first.status,second.status],[202,202]);assert.deepEqual(second.json.data,{status:'received',next:'check_email'});
 assert.deepEqual(await counts(db),{users:1,jobs:1,participants:1,mentors:0});
 const conflict=await call(participants.POST,REG_P,{body:{...body,goal:'leadership'},key});assert.deepEqual([conflict.status,code(conflict)],[409,'IDEMPOTENCY_CONFLICT']);
 const other=await call(participants.POST,REG_P,{body:participantDto('segundo@example.invalid'),key});assert.equal(other.status,202,'outro e-mail = outro escopo');
 assert.deepEqual(await counts(db),{users:2,jobs:2,participants:2,mentors:0});
 const rows=(await db.query('select actor_key,method,path,key_hash,request_hash,resource_id,status_code from api_idempotency order by path,created_at')).rows;
 assert.equal(rows.length,2);for(const row of rows){assert.match(row.actor_key,/^[A-Za-z0-9_-]{43}$/);assert.match(row.key_hash,/^[a-f0-9]{64}$/);assert.deepEqual([row.method,row.path,row.resource_id,row.status_code],['POST',REG_P,null,202]);}
 const dump=JSON.stringify(rows);for(const raw of ['chave@example.invalid',key,'segundo@example.invalid'])assert.equal(dump.toLowerCase().includes(raw.toLowerCase()),false);
}));

test('prazo de mentoras encerrado → 403 antes de qualquer consulta (nem banco nem rate limit)',async()=>withDb(async()=>{
 Reflect.set(process.env,'MENTOR_DEADLINE','2020-01-01T00:00:00.000Z');
 await closeDb();Reflect.set(process.env,'DATABASE_URL','postgres://nobody@127.0.0.1:1/none');
 const r=await call(mentors.POST,REG_M,{body:mentorDto('tarde@example.invalid'),key:randomUUID()});
 assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);assert.equal(r.headers.get('cache-control'),'no-store');
 const bad=await call(mentors.POST,REG_M,{body:mentorDto('tarde@example.invalid'),key:randomUUID(),headers:{Origin:null}});assert.equal(bad.status,403);assert.equal(code(bad),'CSRF_REJECTED','origem vem primeiro');
}));
