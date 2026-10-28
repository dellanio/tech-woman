import assert from 'node:assert/strict';
import {test} from 'node:test';
import {POST as admin} from '../../src/app/api/admin/login/route';
import {POST as mentor} from '../../src/app/api/mentor/route';
import {POST as participant} from '../../src/app/api/participant/route';
import {POST as v1} from '../../src/app/api/v1/auth/login/route';
import {withDb} from './identity-harness.test';

const origin = 'http://app.example.invalid';
const routes = [
  {path:'/api/admin/login',post:admin,status:401,message:'Credenciais inválidas.',body:{email:'missing@example.invalid',password:'wrong-password-123'}},
  {path:'/api/mentor',post:mentor,status:400,message:'Preencha trajetória, especialidades, disponibilidade, capacidade e consentimento.',body:{email:'mentor@example.invalid',trajectory:'Teste',specialties:['dados'],availability:'Quarta',capacity:3,consent:true}},
  {path:'/api/participant',post:participant,status:400,message:'Confira os campos, área de atuação e consentimento para continuar.',body:{email:'participant@example.invalid',goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true}},
];
function req(path:string,body:string,headers:Record<string,string>={}) {
  return new Request(origin+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...headers},body});
}
for (const route of routes) {
  test(`${route.path}: rejects oversized ASCII and UTF8 with v1 INVALID_JSON before rate hit`,()=>withDb(async({db})=>{
    for (const char of ['a','é','🚀']) {
      // Whitespace padding for ASCII also proves a syntactically valid oversized request.
      const body = char === 'a' ? JSON.stringify(route.body)+' '.repeat(65537) : JSON.stringify({padding:char.repeat(33000)});
      assert.ok(Buffer.byteLength(body)>65536);
      const response = await route.post(req(route.path,body));
      assert.equal(response.status,400);
      const out = await response.json();
      assert.deepEqual(out.error,{code:'INVALID_JSON',message:'Envie um JSON válido.',fields:[]});
      assert.equal(response.headers.get('cache-control'),'no-store');
      assert.equal(response.headers.get('set-cookie'),null);
      const reference = await v1(req('/api/v1/auth/login',body));
      assert.equal(reference.status,400);
      assert.deepEqual(out.error,(await reference.json()).error);
    }
    assert.equal((await db.query('select count(*)::int n from auth_rate_bucket')).rows[0].n,0);
  },{MENTOR_DEADLINE:'2099-01-01T00:00:00.000Z'}));

  test(`${route.path}: small valid, malformed, invalid fields, Origin and content type contracts`,()=>withDb(async()=>{
    for (const body of ['{','',JSON.stringify({})]) {
      const response = await route.post(req(route.path,body));
      assert.equal(response.status,route.status);
      assert.deepEqual(await response.json(),{error:route.message});
    }
    const small = await route.post(req(route.path,JSON.stringify(route.body)));
    assert.equal(small.status,route.path.includes('login')?401:202);
    assert.deepEqual(await small.json(),route.path.includes('login')?{error:route.message}:{status:'received',next:'check_email'});
    for (const headers of [{Origin:'https://evil.example.invalid'},{'Sec-Fetch-Site':'cross-site'}] as Record<string,string>[]) {
      const response=await route.post(req(route.path,' '.repeat(70000),headers));
      assert.equal(response.status,403);
      assert.deepEqual(await response.json(),{error:'Origem não autorizada.'});
    }
    for (const type of ['text/plain','']) {
      const response=await route.post(req(route.path,JSON.stringify(route.body),{'Content-Type':type}));
      assert.equal(response.status,400);
      assert.equal((await response.json()).error.code,'INVALID_JSON');
    }
  },{MENTOR_DEADLINE:'2099-01-01T00:00:00.000Z'}));
}

test('mentor: closed deadline precedes JSON guard',()=>withDb(async()=>{
  const response=await mentor(req('/api/mentor',' '.repeat(70000)));
  assert.equal(response.status,403);
  assert.deepEqual(await response.json(),{error:'Cadastro de mentoras encerrado.'});
},{MENTOR_DEADLINE:'2020-01-01T00:00:00.000Z'}));

test('admin: rejected oversized attempts do not consume the five valid-sized login attempts',()=>withDb(async()=>{
  const body=JSON.stringify(routes[0].body);
  for(let i=0;i<5;i++) assert.equal((await admin(req('/api/admin/login',body+' '.repeat(65537)))).status,400);
  for(let i=0;i<5;i++) assert.equal((await admin(req('/api/admin/login',body))).status,401);
  const response=await admin(req('/api/admin/login',body));
  assert.equal(response.status,429);
  assert.ok(Number(response.headers.get('retry-after'))>=1);
}));
