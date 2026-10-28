/** Preview público do crossing via handler real (AJUSTE-INSCRICAO): origem, 64 KiB, DTO fechado, limite por IP, só nome + referência opaca, sem escrita. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import * as preview from '../../src/app/api/v1/registrations/participants/preview/route';
import {mentorRef} from '../../src/lib/crossing';
import {withDb} from './identity-harness.test';
import {call,code} from './identity-http-kit.test';
import {DIAGNOSTIC,crossingMentors,fullSnapshot} from './crossing-fixtures';

const PATH='/api/v1/registrations/participants/preview';
const REF=/^[A-Za-z0-9_-]{43}$/;
type Choice={mentor_ref:string;nome_exibicao:string};

test('preview HTTP: 200 só com mentor_ref/nome_exibicao na ordem do ranking; referência opaca, estável e dependente do segredo; nada gravado',async()=>withDb(async({db})=>{
 const m=await crossingMentors(db);
 const before=await fullSnapshot(db,{sequences:true});
 const r=await call(preview.POST,PATH,{body:DIAGNOSTIC});
 assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
 const data=r.json.data as Choice[];
 assert.deepEqual(data.map(c=>c.nome_exibicao),['Eva Demo','Ana Dados','(MENTORA)','(MENTORA)']);
 for(const c of data){assert.deepEqual(Object.keys(c).sort(),['mentor_ref','nome_exibicao']);assert.match(c.mentor_ref,REF);}
 assert.deepEqual(data.map(c=>c.mentor_ref),[m.eva,m.ana,m.semNome,m.gabi].map(mentorRef),'referência = HMAC do id (resolvida no servidor)');
 assert.equal(new Set(data.map(c=>c.mentor_ref)).size,4);
 for(const id of Object.values(m))assert.equal(data.some(c=>c.mentor_ref===id||c.mentor_ref.includes(Buffer.from(id).toString('base64url'))),false,'id sequencial não exposto');
 assert.equal(/@|score|reasons|trajectory|"id"|email/i.test(r.text),false,'nada além de nome e referência');
 const again=await call(preview.POST,PATH,{body:{...DIAGNOSTIC,interests:['design','dados']}});
 assert.deepEqual(again.json.data,data,'estável entre chamadas (ordem dos interesses não importa)');
 const previous=process.env.SESSION_SECRET;process.env.SESSION_SECRET=randomBytes(48).toString('hex');
 try{const other=await call(preview.POST,PATH,{body:DIAGNOSTIC});assert.notDeepEqual((other.json.data as Choice[]).map(c=>c.mentor_ref),data.map(c=>c.mentor_ref),'sem o segredo não se deriva a referência');}
 finally{process.env.SESSION_SECRET=previous;}
 const none=await call(preview.POST,PATH,{body:{...DIAGNOSTIC,goal:'transition',interests:['desenvolvimento'],skills:['codigo'],area:'outra',otherArea:'Biotecnologia'}});
 assert.deepEqual([none.status,none.json.data],[200,[]],'sem compatíveis: lista vazia, sem match inventado');
 assert.deepEqual(await fullSnapshot(db,{sequences:true}),before,'preview não cria app_user/participant/match nem nada além do balde de rate');
}));

test('preview HTTP: origem verificada, JSON ≤ 64 KiB, DTO fechado sem e-mail/credenciais/consentimento',async()=>withDb(async({db})=>{
 await crossingMentors(db);const before=await fullSnapshot(db);
 let r=await call(preview.POST,PATH,{body:DIAGNOSTIC,headers:{Origin:null}});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
 r=await call(preview.POST,PATH,{body:DIAGNOSTIC,headers:{Origin:'http://evil.example.invalid'}});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
 r=await call(preview.POST,PATH,{body:DIAGNOSTIC,headers:{'Sec-Fetch-Site':'cross-site'}});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
 r=await call(preview.POST,PATH,{body:DIAGNOSTIC,headers:{'Content-Type':'text/plain'}});assert.deepEqual([r.status,code(r)],[400,'INVALID_JSON']);
 r=await call(preview.POST,PATH,{raw:JSON.stringify({...DIAGNOSTIC,area:'outra',otherArea:'x'.repeat(66000)})});assert.deepEqual([r.status,code(r)],[400,'INVALID_JSON'],'corpo acima de 64 KiB');
 r=await call(preview.POST,PATH,{raw:'{"goal":'});assert.deepEqual([r.status,code(r)],[400,'INVALID_JSON']);
 for(const extra of ['email','password','passwordConfirmation','consent','mentor_ref','userId']){
  r=await call(preview.POST,PATH,{body:{...DIAGNOSTIC,[extra]:extra==='consent'?true:'x@example.invalid'}});
  assert.deepEqual([extra,r.status,code(r)],[extra,422,'INVALID_INPUT']);assert.ok(r.json.error.fields.includes(extra));
 }
 r=await call(preview.POST,PATH,{body:{...DIAGNOSTIC,goal:'x'}});assert.deepEqual([r.status,r.json.error.fields],[422,['goal']]);
 r=await call(preview.POST,PATH,{body:{...DIAGNOSTIC,interests:[]}});assert.deepEqual([r.status,r.json.error.fields],[422,['interests']]);
 assert.deepEqual(await fullSnapshot(db),before);
}));

test('preview HTTP: limite por IP (enforceRate) com Retry-After; outro IP não é afetado',async()=>withDb(async({db})=>{
 await crossingMentors(db);
 const ip=(addr:string)=>({'X-Forwarded-For':`198.51.100.9, ${addr}`});
 for(let i=1;i<=3;i++){const r=await call(preview.POST,PATH,{body:DIAGNOSTIC,headers:ip('203.0.113.7')});assert.equal(r.status,200,`tentativa ${i}`);}
 const blocked=await call(preview.POST,PATH,{body:DIAGNOSTIC,headers:ip('203.0.113.7')});
 assert.deepEqual([blocked.status,code(blocked)],[429,'RATE_LIMITED']);
 const retry=Number(blocked.headers.get('retry-after'));assert.ok(Number.isInteger(retry)&&retry>=1&&retry<=3600);
 assert.equal((await call(preview.POST,PATH,{body:DIAGNOSTIC,headers:ip('203.0.113.8')})).status,200,'balde por IP');
 const buckets=JSON.stringify((await db.query('select bucket_key from auth_rate_bucket')).rows);
 assert.equal(buckets.includes('203.0.113'),false,'balde é HMAC, sem IP bruto');
},{RATE_PREVIEW_IP_PER_HOUR:'3',TRUST_PROXY:'1'}));
