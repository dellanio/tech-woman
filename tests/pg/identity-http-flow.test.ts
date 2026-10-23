import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import * as email from '../../src/lib/email';
import * as login from '../../src/app/api/v1/auth/login/route';
import * as logout from '../../src/app/api/v1/auth/logout/route';
import * as session from '../../src/app/api/v1/auth/session/route';
import * as csrf from '../../src/app/api/v1/auth/csrf/route';
import * as change from '../../src/app/api/v1/auth/password/change/route';
import * as forgot from '../../src/app/api/v1/auth/password/forgot/route';
import * as reset from '../../src/app/api/v1/auth/password/reset/route';
import * as participants from '../../src/app/api/v1/registrations/participants/route';
import * as profileParticipant from '../../src/app/api/v1/me/profiles/participant/route';
import * as profileMentor from '../../src/app/api/v1/me/profiles/mentor/route';
import {withDb,addUser,sessionFor,synthetic,participantRow} from './identity-harness.test';
import {call,code,sessionCookie,captureOutput,has,type Reply} from './identity-http-kit.test';

const profile={goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true};
const mentorProfile={displayName:'Mentora Fictícia',trajectory:'Trajetória de teste',specialties:['produto'],availability:'Quartas',legacyCapacity:3,consent:true};
const dto=(addr:string)=>({email:addr,...profile});
const csrfFor=async(token:string)=>{const r=await call(csrf.GET,'/api/v1/auth/csrf',{cookie:token});assert.equal(r.status,200);return String(r.json.data.csrfToken);};
/** Esvazia a fila com o worker em memória e devolve as mensagens (segredos só aqui, em memória do teste). */
const drain=async()=>{const messages:email.EmailMessage[]=[];await email.runEmailWorkerOnce(email.createMemoryTransport(m=>{messages.push(m);}));return messages;};
const leaked=async(db:Pool,secrets:string[])=>{
 const tables=(await db.query("select table_schema s,table_name t from information_schema.tables where table_schema in ('public','internal','legacy_snapshot') and table_type='BASE TABLE'")).rows;
 for(const {s,t} of tables){const dump=JSON.stringify((await db.query(`select to_jsonb(x)::text j from ${s}.${t} x`)).rows);if(has(dump,secrets))return true;}
 return false;
};
const sessionRoles=async(token:string)=>(await call(session.GET,'/api/v1/auth/session',{cookie:token})).json?.data?.user?.roles;

test('fluxo HTTP: cadastro → worker em memória → login limitado → troca → perfil próprio → logout → esqueci → reset; sem segredo em tabelas nem logs',async()=>withDb(async({db})=>{
 const logs=captureOutput();const secrets:string[]=[];
 try{
  const addr='Fluxo.Http@Example.invalid';
  const reg=await call(participants.POST,'/api/v1/registrations/participants',{body:dto(addr),key:randomUUID()});
  assert.deepEqual([reg.status,reg.json.data],[202,{status:'received',next:'check_email'}]);
  const sent=await drain();assert.equal(sent.length,1);const temp=sent[0].secret;secrets.push(temp);
  // login com o temporário: sessão limitada de 10 min, token só no cookie
  const limited=await call(login.POST,'/api/v1/auth/login',{body:{email:addr.toLowerCase(),password:temp}});
  assert.deepEqual([limited.status,limited.json.data],[200,{state:'password_change_required'}]);
  const lc=sessionCookie(limited);assert.ok(lc);secrets.push(lc.token);
  assert.deepEqual(lc.attrs.filter(a=>a!=='Secure').sort(),['HttpOnly','Max-Age=600','Path=/','SameSite=Strict'].sort());
  assert.equal(lc.attrs.includes('Secure'),false,'dev local sem Secure');assert.equal(limited.text.includes(lc.token),false);assert.equal(limited.headers.get('cache-control'),'no-store');
  const again=await call(login.POST,'/api/v1/auth/login',{body:{email:addr,password:temp}});assert.equal(again.status,401,'temporário consumido: segundo login recusado');
  assert.deepEqual((await call(session.GET,'/api/v1/auth/session',{cookie:lc.token})).json.data.state,'password_change_required');
  const minimal=(await call(session.GET,'/api/v1/auth/session',{cookie:lc.token})).json.data;assert.deepEqual(Object.keys(minimal).sort(),['expiresAt','state']);
  // sessão limitada não acessa nada além da troca
  let r=await call(profileMentor.POST,'/api/v1/me/profiles/mentor',{body:mentorProfile,cookie:lc.token});assert.deepEqual([r.status,code(r)],[403,'PASSWORD_CHANGE_REQUIRED']);
  const lcsrf=await csrfFor(lc.token);
  r=await call(change.POST,'/api/v1/auth/password/change',{body:{currentPassword:temp,newPassword:'curta'},cookie:lc.token,csrf:lcsrf});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);
  const fresh=synthetic();secrets.push(fresh);
  r=await call(change.POST,'/api/v1/auth/password/change',{body:{currentPassword:temp,newPassword:fresh},cookie:lc.token});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
  r=await call(change.POST,'/api/v1/auth/password/change',{body:{currentPassword:temp,newPassword:fresh},cookie:lc.token,csrf:'x'.repeat(43)});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
  r=await call(change.POST,'/api/v1/auth/password/change',{body:{currentPassword:'senha-errada-123',newPassword:fresh},cookie:lc.token,csrf:lcsrf});assert.deepEqual([r.status,code(r)],[401,'INVALID_CREDENTIALS']);
  r=await call(change.POST,'/api/v1/auth/password/change',{body:{currentPassword:temp,newPassword:fresh,extra:1},cookie:lc.token,csrf:lcsrf});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);
  r=await call(change.POST,'/api/v1/auth/password/change',{body:{currentPassword:temp,newPassword:fresh},cookie:lc.token,csrf:lcsrf});
  assert.deepEqual([r.status,r.json.data],[200,{state:'authenticated'}]);
  const fc=sessionCookie(r);assert.ok(fc);secrets.push(fc.token);assert.ok(fc.attrs.includes('Max-Age=86400'));assert.equal(fc.token===lc.token,false);
  assert.equal((await call(session.GET,'/api/v1/auth/session',{cookie:lc.token})).status,401,'sessão limitada revogada');
  const who=(await call(session.GET,'/api/v1/auth/session',{cookie:fc.token})).json.data;
  assert.deepEqual([who.state,who.user.email,who.user.roles,Object.keys(who.user).sort(),typeof who.expiresAt],['authenticated',addr,['participant'],['email','id','roles'],'string']);
  // perfil próprio: CSRF, DTO fechado, sem mass assignment, sem duplicata
  const fcsrf=await csrfFor(fc.token);secrets.push(fcsrf);
  assert.deepEqual(await sessionRoles(fc.token),['participant']);
  r=await call(profileMentor.POST,'/api/v1/me/profiles/mentor',{body:mentorProfile,cookie:fc.token});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
  for(const extra of [{email:'x@example.invalid'},{roles:['admin']},{userId:'1'}]){r=await call(profileMentor.POST,'/api/v1/me/profiles/mentor',{body:{...mentorProfile,...extra},cookie:fc.token,csrf:fcsrf});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);}
  r=await call(profileMentor.POST,'/api/v1/me/profiles/mentor',{body:mentorProfile,cookie:fc.token,csrf:fcsrf});assert.equal(r.status,201);assert.equal(r.headers.get('cache-control'),'no-store');
  r=await call(profileMentor.POST,'/api/v1/me/profiles/mentor',{body:mentorProfile,cookie:fc.token,csrf:fcsrf});assert.deepEqual([r.status,code(r)],[409,'PROFILE_EXISTS']);
  r=await call(profileParticipant.POST,'/api/v1/me/profiles/participant',{body:profile,cookie:fc.token,csrf:fcsrf});assert.deepEqual([r.status,code(r)],[409,'PROFILE_EXISTS']);
  assert.deepEqual(await sessionRoles(fc.token),['mentor','participant']);
  // logout
  r=await call(logout.POST,'/api/v1/auth/logout',{cookie:fc.token});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED']);
  r=await call(logout.POST,'/api/v1/auth/logout',{cookie:fc.token,csrf:fcsrf});assert.equal(r.status,204);assert.equal(r.text,'');assert.match(String(r.headers.get('set-cookie')),/tw_session=;.*Max-Age=0/);
  assert.equal((await call(session.GET,'/api/v1/auth/session',{cookie:fc.token})).status,401);
  assert.equal((await call(logout.POST,'/api/v1/auth/logout',{})).status,204,'sem sessão: idempotente');
  // esqueci a senha → worker → reset
  r=await call(forgot.POST,'/api/v1/auth/password/forgot',{body:{email:addr}});assert.deepEqual([r.status,r.json.data],[202,{status:'received'}]);
  const resetMail=await drain();assert.equal(resetMail.length,1);assert.equal(resetMail[0].kind,'password_reset');const token=resetMail[0].secret;secrets.push(token);
  const stillIn=await call(login.POST,'/api/v1/auth/login',{body:{email:addr,password:fresh}});assert.equal(stillIn.status,200,'forgot não invalida a senha atual');const oldSession=sessionCookie(stillIn);assert.ok(oldSession);secrets.push(oldSession.token);
  const next=synthetic();secrets.push(next);
  r=await call(reset.POST,'/api/v1/auth/password/reset',{body:{token,newPassword:'curta'}});assert.deepEqual([r.status,code(r)],[422,'INVALID_INPUT']);
  r=await call(reset.POST,'/api/v1/auth/password/reset',{body:{token:'x'.repeat(43),newPassword:next}});assert.deepEqual([r.status,code(r)],[400,'INVALID_RESET']);
  r=await call(reset.POST,'/api/v1/auth/password/reset',{body:{token,newPassword:next}});assert.equal(r.status,204);assert.equal(r.text,'');
  r=await call(reset.POST,'/api/v1/auth/password/reset',{body:{token,newPassword:synthetic()}});assert.deepEqual([r.status,code(r)],[400,'INVALID_RESET'],'uso único');
  assert.equal((await call(session.GET,'/api/v1/auth/session',{cookie:oldSession.token})).status,401,'reset revoga sessões');
  assert.equal((await call(login.POST,'/api/v1/auth/login',{body:{email:addr,password:fresh}})).status,401);
  const final=await call(login.POST,'/api/v1/auth/login',{body:{email:addr,password:next}});assert.deepEqual([final.status,final.json.data],[200,{state:'authenticated'}]);
  const finalCookie=sessionCookie(final);assert.ok(finalCookie);secrets.push(finalCookie.token);
  // varredura: tabelas e saída capturada
  logs.stop();
  assert.equal(await leaked(db,secrets),false,'nenhum segredo/token/senha persistido');
  assert.equal(has(logs.text(),secrets),false,'nenhum segredo nos logs do servidor');
  assert.equal(/password|senha/i.test(logs.text().replace(/password_?[a-z]*:?\s*(false|true)/gi,''))&&has(logs.text(),secrets),false);
 }finally{logs.stop();}
}));

test('cookie tw_session: Secure em produção, dispensado só com ALLOW_LOCAL_HTTP ou fora de produção; limitado 600s, full 86400s',async()=>{
 const check=async(env:Record<string,string>,expectSecure:boolean)=>withDb(async({db})=>{
  const pw=synthetic();const u=await addUser(db,{password:pw});
  const r=await call(login.POST,'/api/v1/auth/login',{body:{email:u.email,password:pw}});assert.equal(r.status,200);
  const c=sessionCookie(r);assert.ok(c);assert.equal(c.attrs.includes('Secure'),expectSecure,JSON.stringify(env));
  assert.deepEqual(['HttpOnly','SameSite=Strict','Path=/','Max-Age=86400'].filter(a=>!c.attrs.includes(a)),[]);
 },env);
 await check({NODE_ENV:'production'},true);await check({NODE_ENV:'production',ALLOW_LOCAL_HTTP:'1'},false);await check({NODE_ENV:'development'},false);
});

test('perfil próprio: admin/team → 404, sessão inválida/revogada → 401, prazo de mentora → 403, legado por reconciliar → 409, CSRF de outra sessão → 403',async()=>withDb(async({db})=>{
 const admin=await addUser(db,{password:synthetic(),roles:['admin','mentor']}),team=await addUser(db,{password:synthetic(),roles:['team']}),plain=await addUser(db,{email:'plain@example.invalid',password:synthetic(),roles:['mentor']});
 const sa=await sessionFor(db,admin.id),st=await sessionFor(db,team.id),sp=await sessionFor(db,plain.id),sp2=await sessionFor(db,plain.id);
 const ca=await csrfFor(sa),ct=await csrfFor(st),cp=await csrfFor(sp);
 let r=await call(profileParticipant.POST,'/api/v1/me/profiles/participant',{body:profile,cookie:sa,csrf:ca});assert.deepEqual([r.status,code(r)],[404,'NOT_FOUND']);
 r=await call(profileParticipant.POST,'/api/v1/me/profiles/participant',{body:profile,cookie:st,csrf:ct});assert.deepEqual([r.status,code(r)],[404,'NOT_FOUND']);
 assert.equal((await db.query('select count(*)::int n from participant')).rows[0].n,0);
 r=await call(profileParticipant.POST,'/api/v1/me/profiles/participant',{body:profile,cookie:sp,csrf:await csrfFor(sp2)});assert.deepEqual([r.status,code(r)],[403,'CSRF_REJECTED'],'CSRF é ligado à sessão');
 r=await call(profileParticipant.POST,'/api/v1/me/profiles/participant',{body:profile});assert.deepEqual([r.status,code(r)],[401,'AUTH_REQUIRED']);
 r=await call(profileParticipant.POST,'/api/v1/me/profiles/participant',{body:profile,cookie:'a'.repeat(43),csrf:cp});assert.deepEqual([r.status,code(r)],[401,'AUTH_REQUIRED']);
 await participantRow(db,77,'PLAIN@example.invalid');
 r=await call(profileParticipant.POST,'/api/v1/me/profiles/participant',{body:profile,cookie:sp,csrf:cp});assert.deepEqual([r.status,code(r)],[409,'IDENTITY_RECONCILIATION_REQUIRED']);
 assert.equal((await db.query('select user_id is null n from participant where id=77')).rows[0].n,true,'nunca liga por e-mail');
 await db.query('delete from participant where id=77');
 r=await call(profileParticipant.POST,'/api/v1/me/profiles/participant',{body:profile,cookie:sp,csrf:cp});assert.equal(r.status,201);
 Reflect.set(process.env,'MENTOR_DEADLINE','2020-01-01T00:00:00.000Z');
 r=await call(profileMentor.POST,'/api/v1/me/profiles/mentor',{body:mentorProfile,cookie:sp,csrf:cp});assert.deepEqual([r.status,code(r)],[403,'FORBIDDEN']);
 await db.query("update auth_session set revoked_at=now() where user_id=$1",[plain.id]);
 r=await call(profileParticipant.POST,'/api/v1/me/profiles/participant',{body:profile,cookie:sp,csrf:cp});assert.deepEqual([r.status,code(r)],[401,'AUTH_REQUIRED']);
}));
void (null as unknown as Reply);
