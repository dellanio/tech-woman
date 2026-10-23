import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {closeDb,hashPassword,tokenDigest} from '../../src/lib/db';
import * as legacyLogin from '../../src/app/api/admin/login/route';
import * as legacyLogout from '../../src/app/api/admin/logout/route';
import * as legacyParticipant from '../../src/app/api/participant/route';
import * as legacyMentor from '../../src/app/api/mentor/route';
import * as session from '../../src/app/api/v1/auth/session/route';
import * as service from '../../src/lib/service';
import * as email from '../../src/lib/email';
import {withDb,addUser,sessionFor,synthetic,linkFixture} from './identity-harness.test';
import {call,sessionCookie,type Reply} from './identity-http-kit.test';

const LOGIN='/api/admin/login',LOGOUT='/api/admin/logout';
const doLogin=(emailAddr:string,password:string,extra:Parameters<typeof call>[2]={})=>call(legacyLogin.POST,LOGIN,{body:{email:emailAddr,password},...extra});
const participantBody=(addr:string,extra:Record<string,unknown>={})=>({email:addr,goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true,...extra});
const mentorBody=(addr:string,extra:Record<string,unknown>={})=>({email:addr,trajectory:'Trajetória sintética',specialties:['dados'],availability:'Sem horário',capacity:4,consent:true,...extra});
const useOwnerPool=async(url:string)=>{await closeDb();Reflect.set(process.env,'DATABASE_URL',url);};
const cookieNames=(r:Reply)=>(r.headers.getSetCookie?.()??[]).map(c=>c.split('=')[0]);

test('adapter /api/admin/login: só admin/team completos recebem tw_session; demais 401 sem cookie e com sessão revogada; troca pendente 403 com cookie limitado',async()=>withDb(async({db})=>{
 const pw=synthetic();
 const admin=await addUser(db,{email:'adm@example.invalid',password:pw,roles:['admin']}),team=await addUser(db,{email:'eq@example.invalid',password:pw,roles:['team']});
 const plain=await addUser(db,{email:'plain@example.invalid',password:pw,roles:['participant']}),dis=await addUser(db,{email:'off@example.invalid',password:pw,status:'disabled',roles:['admin']});
 let r=await doLogin(' ADM@example.invalid ',pw);
 assert.deepEqual([r.status,r.json],[200,{email:'adm@example.invalid',role:'owner'}]);const c=sessionCookie(r);assert.ok(c);assert.deepEqual(cookieNames(r),['tw_session']);
 assert.deepEqual(['HttpOnly','SameSite=Strict','Path=/','Max-Age=86400'].filter(a=>!c.attrs.includes(a)),[]);assert.equal(r.text.includes(c.token),false);
 assert.equal((await call(session.GET,'/api/v1/auth/session',{cookie:c.token})).json.data.user.roles[0],'admin','mesma sessão opaca do /api/v1');
 r=await doLogin(team.email,pw);assert.deepEqual([r.status,r.json],[200,{email:'eq@example.invalid',role:'member'}]);
 const before=(await db.query('select count(*)::int n from auth_session where revoked_at is null')).rows[0].n;
 for(const [addr,password] of [[plain.email,pw],[admin.email,pw+'x'],[dis.email,pw],['ninguem@example.invalid',pw]] as const){
  r=await doLogin(addr,password);assert.deepEqual([addr,r.status,r.json,r.headers.get('set-cookie')],[addr,401,{error:'Credenciais inválidas.'},null]);
 }
 assert.equal((await db.query('select count(*)::int n from auth_session where revoked_at is null')).rows[0].n,before,'a sessão criada para o usuário comum foi revogada na hora');
 assert.equal((await db.query('select count(*)::int n from auth_session s where s.user_id=$1 and s.revoked_at is not null',[plain.id])).rows[0].n,1);
 r=await call(legacyLogin.POST,LOGIN,{raw:'não é json'});assert.deepEqual([r.status,r.json],[401,{error:'Credenciais inválidas.'}]);
 r=await doLogin(admin.email,pw,{headers:{Origin:null}});assert.deepEqual([r.status,r.json],[403,{error:'Origem não autorizada.'}]);
 // troca pendente: 403 + cookie limitado para a UI nova trocar a senha; nunca tw_admin
 await db.query("update app_user set must_change_password=true,temporary_password_hash=$2,temporary_expires_at=now()+interval '1 hour' where id=$1",[admin.id,await hashPassword('temp-temp-temp-123')]);
 r=await doLogin(admin.email,'temp-temp-temp-123');assert.deepEqual([r.status,r.json],[403,{error:'Troca de senha obrigatória.'}]);
 const lim=sessionCookie(r);assert.ok(lim);assert.ok(lim.attrs.includes('Max-Age=600'));assert.deepEqual(cookieNames(r),['tw_session']);
 assert.equal((await call(session.GET,'/api/v1/auth/session',{cookie:lim.token})).json.data.state,'password_change_required');
}));

test('adapter /api/admin/login respeita o limitador de taxa (sem bypass pelo caminho antigo)',async()=>withDb(async()=>{
 for(let i=1;i<=5;i++)assert.equal((await doLogin('alvo@example.invalid','errada-errada-12')).status,401);
 const r=await doLogin('alvo@example.invalid','errada-errada-12');assert.equal(r.status,429);assert.ok(Number(r.headers.get('retry-after'))>=1);assert.equal(r.headers.get('set-cookie'),null);
}));

test('adapter /api/admin/logout: revoga a sessão, limpa tw_session e o antigo tw_admin; exige Origin',async()=>withDb(async({db})=>{
 const pw=synthetic();const admin=await addUser(db,{email:'adm@example.invalid',password:pw,roles:['admin']});
 const token=sessionCookie(await doLogin(admin.email,pw))?.token??'';assert.ok(token);
 let r=await call(legacyLogout.POST,LOGOUT,{method:'POST',cookie:token,headers:{Origin:null}});assert.equal(r.status,403);
 assert.equal((await call(session.GET,'/api/v1/auth/session',{cookie:token})).status,200,'sem Origin nada foi revogado');
 r=await call(legacyLogout.POST,LOGOUT,{method:'POST',cookie:token});
 assert.deepEqual([r.status,r.json],[200,{ok:true}]);const cookies=r.headers.getSetCookie?.()??[];
 assert.deepEqual(cookies.map(c=>c.split('=')[0]).sort(),['tw_admin','tw_session']);assert.equal(cookies.every(c=>/Max-Age=0/.test(c)),true);
 assert.equal((await call(session.GET,'/api/v1/auth/session',{cookie:token})).status,401);
 assert.equal((await db.query('select count(*)::int n from auth_session where revoked_at is null')).rows[0].n,0);
}));

test('adapters /api/participant e /api/mentor: 202 neutro sem token/protocolo, conta nova pendente, admin/duplicado sem mutação, limite e prazo preservados',async()=>withDb(async({db})=>{
 const pw=synthetic();const admin=await addUser(db,{email:'adm@example.invalid',password:pw,roles:['admin']});
 let r=await call(legacyParticipant.POST,'/api/participant',{body:participantBody('Nova.Legada@Example.invalid')});
 assert.deepEqual([r.status,r.json],[202,{status:'received',next:'check_email'}]);assert.equal(r.headers.get('cache-control'),'no-store');
 assert.deepEqual((await db.query("select u.status,(select count(*)::int from participant p where p.user_id=u.id) p,(select count(*)::int from email_job j where j.user_id=u.id and j.kind='registration') j from app_user u where email_key='nova.legada@example.invalid'")).rows,[{status:'pending_activation',p:1,j:1}]);
 r=await call(legacyMentor.POST,'/api/mentor',{body:mentorBody('mentora.legada@example.invalid')});
 assert.deepEqual([r.status,r.json],[202,{status:'received',next:'check_email'}]);
 assert.deepEqual((await db.query("select m.display_name,m.capacity,m.active,m.demo,u.status from mentor m join app_user u on u.id=m.user_id where m.email='mentora.legada@example.invalid'")).rows,[{display_name:null,capacity:4,active:true,demo:false,status:'pending_activation'}]);
 const before=JSON.stringify((await db.query("select (select count(*)::int from app_user) u,(select count(*)::int from participant) p,(select count(*)::int from mentor) m,(select count(*)::int from email_job) j,(select count(*)::int from user_role) r")).rows[0]);
 for(const addr of ['adm@example.invalid','ADM@example.invalid ','nova.legada@example.invalid']){
  r=await call(legacyParticipant.POST,'/api/participant',{body:participantBody(addr,{goal:'leadership'})});assert.deepEqual([r.status,r.json],[202,{status:'received',next:'check_email'}]);
  r=await call(legacyMentor.POST,'/api/mentor',{body:mentorBody(addr)});assert.deepEqual([r.status,r.json],[202,{status:'received',next:'check_email'}]);
 }
 const after=JSON.stringify((await db.query("select (select count(*)::int from app_user) u,(select count(*)::int from participant) p,(select count(*)::int from mentor) m,(select count(*)::int from email_job) j,(select count(*)::int from user_role) r")).rows[0]);
 assert.equal(after,before,'admin e duplicados: nada muda');
 r=await call(legacyParticipant.POST,'/api/participant',{body:participantBody('x@example.invalid',{userId:'9',roles:['admin']})});assert.equal(r.status,400);assert.equal(typeof r.json.error,'string');
 r=await call(legacyParticipant.POST,'/api/participant',{body:participantBody('y@example.invalid'),headers:{Origin:null}});assert.deepEqual([r.status,r.json],[403,{error:'Origem não autorizada.'}]);
 r=await call(legacyParticipant.POST,'/api/participant',{raw:'{'});assert.equal(r.status,400);
 for(let i=0;i<3;i++)await call(legacyParticipant.POST,'/api/participant',{body:participantBody('limite@example.invalid')});
 r=await call(legacyParticipant.POST,'/api/participant',{body:participantBody('limite@example.invalid')});assert.equal(r.status,429,'o caminho antigo usa os mesmos limites');
 const open=await call(legacyMentor.GET,'/api/mentor');assert.equal(typeof open.json.open,'boolean');
 Reflect.set(process.env,'MENTOR_DEADLINE','2020-01-01T00:00:00.000Z');
 await closeDb();Reflect.set(process.env,'DATABASE_URL','postgres://nobody@127.0.0.1:1/none');
 r=await call(legacyMentor.POST,'/api/mentor',{body:mentorBody('tarde@example.invalid')});assert.deepEqual([r.status,r.json],[403,{error:'Cadastro de mentoras encerrado.'}]);
 void admin;
}));

test('service legado: overview/decide/change/remove-demo excluem linhas de domínio protegidas (multi-perfil, NULL privilegiado, vínculo); authenticate vira identidade revogável',async()=>withDb(async({db,url})=>{
 const pw=synthetic();const {link}=await linkFixture(db);
 const admin=await addUser(db,{email:'dona@example.invalid',password:pw,roles:['admin','mentor','participant']});
 const insP=(id:number,addr:string,userId:string|null=null)=>db.query("insert into participant(id,email,goal,moment,interests,skills,area,token_hash,consent_version,user_id) values($1,$2,'growth','working','[\"dados\"]','[\"analise\"]','dados',$3,'v0',$4)",[id,addr,String(id).padStart(64,'a'),userId]);
 const insM=(id:number,addr:string,opts:{demo?:boolean;userId?:string|null}={})=>db.query("insert into mentor(id,email,trajectory,specialties,availability,capacity,active,demo,demo_name,user_id) values($1,$2,'t','[\"dados\"]','a',3,true,$3,$4,$5)",[id,addr,opts.demo??false,opts.demo?`Demo ${id}`:null,opts.userId??null]);
 await insP(1,'plain.p@example.invalid');await insM(2,'plain.m@example.invalid');await insM(3,'demo.livre@example.invalid',{demo:true});
 await insP(10,'dona@example.invalid',admin.id);await insM(20,'dona@example.invalid',{userId:admin.id});await insM(4,'demo.admin@example.invalid',{demo:true,userId:admin.id});
 await insP(30,'  DONA@example.invalid');await insM(31,'cand.m@example.invalid');await link('mentor','31',null,'privileged_candidate');await insP(32,'cand.p@example.invalid');await link('participant','32',null,'privileged_candidate');
 await useOwnerPool(url);
 const overview=await service.adminOverview();
 assert.deepEqual(overview.participants.map(p=>p.id),['1'],'só participante comum');assert.deepEqual(overview.mentors.map(m=>m.id).sort(),['2','3']);
 assert.deepEqual(overview.participants[0].choices.map(c=>c.mentorId).sort(),['2','3'],'sugestões nunca incluem mentora protegida');
 const rejects=async(p:Promise<unknown>)=>p.then(()=>'resolved',e=>e instanceof service.Invalid?`${e.status}`:'UNEXPECTED');
 assert.equal(await rejects(service.decide(1,20,'approve')),'404');assert.equal(await rejects(service.decide(1,4,'approve')),'404');assert.equal(await rejects(service.decide(1,31,'approve')),'404');
 for(const pid of [10,30,32])assert.equal(await rejects(service.decide(pid,2,'approve')),'404');
 assert.equal(await rejects(service.adminChange(10,null,'cancel')),'404');assert.equal(await rejects(service.adminChange(1,20,'reassign')),'404');assert.equal(await rejects(service.adminChange(30,2,'reassign')),'404');
 for(const mid of [20,4,31])assert.equal(await rejects(service.setMentorActive(mid,false)),'404');
 assert.equal((await db.query('select count(*)::int n from mentor where id in (20,4,31) and active')).rows[0].n,3);
 assert.equal((await db.query('select count(*)::int n from match')).rows[0].n,0,'nenhum par criado/alterado');
 assert.deepEqual(await service.removeDemoMentors(),{status:'1 mentoras de demonstração desativadas.'});
 assert.deepEqual((await db.query('select id::int,active from mentor where demo order by id')).rows,[{id:3,active:false},{id:4,active:true}],'demo vinculada a admin fica intacta');
 assert.deepEqual(await service.decide(1,2,'approve'),{status:'Par aprovado'},'fluxo comum continua funcionando');
 // authenticate: wrapper de identidade, sem sessão sem estado nem sessão viva
 assert.deepEqual(await service.authenticate(admin.email,pw),{email:'dona@example.invalid',role:'owner'});
 assert.equal(await service.authenticate(admin.email,pw+'x'),null);
 const common=await addUser(db,{email:'comum@example.invalid',password:pw});assert.equal(await service.authenticate(common.email,pw),null);
 assert.equal((await db.query('select count(*)::int n from auth_session where revoked_at is null')).rows[0].n,0,'authenticate não deixa sessão viva');
 void email;void sessionFor;void tokenDigest;void (null as unknown as Pool);
}));
