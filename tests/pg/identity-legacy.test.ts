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
import * as legacyOverview from '../../src/app/api/admin/overview/route';
import * as legacyDecide from '../../src/app/api/admin/decide/route';
import * as legacyChange from '../../src/app/api/admin/change/route';
import {actorOf,as,type Actor} from './agenda-api-kit';
import * as email from '../../src/lib/email';
import {withDb,addUser,sessionFor,synthetic,linkFixture} from './identity-harness.test';
import {runPrivilegedAccount} from '../../scripts/privileged-account';
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

// Contrato final (CONTRATOS §7, linhas 112–113): os caminhos antigos passam pelos adapters HTTP com sessão admin+CSRF; approve sem turma → 422.
const adminPost=(a:Actor,handler:Parameters<typeof call>[0],path:string,body:unknown)=>as(a).send(handler,path,{body});
test('adapters legados: overview/decide/change/remove-demo excluem linhas de domínio protegidas (multi-perfil, NULL privilegiado, vínculo); authenticate vira identidade revogável',async()=>withDb(async({db})=>{
 const pw=synthetic();const {link}=await linkFixture(db);
 const admin=await addUser(db,{email:'dona@example.invalid',password:pw,roles:['admin','mentor','participant']});const actor=await actorOf(db,['admin']);
 const insP=(id:number,addr:string,userId:string|null=null)=>db.query("insert into participant(id,email,goal,moment,interests,skills,area,token_hash,consent_version,user_id) values($1,$2,'growth','working','[\"dados\"]','[\"analise\"]','dados',$3,'v0',$4)",[id,addr,String(id).padStart(64,'a'),userId]);
 const insM=(id:number,addr:string,opts:{demo?:boolean;userId?:string|null}={})=>db.query("insert into mentor(id,email,trajectory,specialties,availability,capacity,active,demo,demo_name,user_id) values($1,$2,'t','[\"dados\"]','a',3,true,$3,$4,$5)",[id,addr,opts.demo??false,opts.demo?`Demo ${id}`:null,opts.userId??null]);
 await insP(1,'plain.p@example.invalid');await insM(2,'plain.m@example.invalid');await insM(3,'demo.livre@example.invalid',{demo:true});
 await insP(10,'dona@example.invalid',admin.id);await insM(20,'dona@example.invalid',{userId:admin.id});await insM(4,'Dona@example.invalid',{demo:true});
 await insP(30,'  DONA@example.invalid');await insM(31,'cand.m@example.invalid');await link('mentor','31',null,'privileged_candidate');await insP(32,'cand.p@example.invalid');await link('participant','32',null,'privileged_candidate');
 const overview=(await as(actor).get(legacyOverview.GET,'/api/admin/overview')).json;
 assert.deepEqual(overview.participants.map((p:{id:string})=>p.id),['1'],'só participante comum');assert.deepEqual(overview.mentors.map((m:{id:string})=>m.id).sort(),['2','3']);
 assert.deepEqual(overview.participants[0].choices.map((c:{mentorId:string})=>c.mentorId).sort(),['2','3'],'sugestões nunca incluem mentora protegida');
 const status=async(r:Promise<Reply>)=>String((await r).status);
 const decideAs=(participantId:number,mentorId:number,action:string)=>status(adminPost(actor,legacyDecide.POST,'/api/admin/decide',{participantId,mentorId,action}));
 const changeAs=(body:Record<string,unknown>)=>status(adminPost(actor,legacyChange.POST,'/api/admin/change',body));
 assert.equal(await decideAs(1,20,'approve'),'404');assert.equal(await decideAs(1,4,'approve'),'404');assert.equal(await decideAs(1,31,'approve'),'404');
 for(const pid of [10,30,32])assert.equal(await decideAs(pid,2,'approve'),'404');
 assert.equal(await changeAs({participantId:10,action:'cancel'}),'404');assert.equal(await changeAs({participantId:1,mentorId:20,action:'reassign'}),'404');assert.equal(await changeAs({participantId:30,mentorId:2,action:'reassign'}),'404');
 for(const mid of [20,4,31])assert.equal(await changeAs({mentorId:mid,action:'deactivate'}),'404');
 assert.equal((await db.query('select count(*)::int n from mentor where id in (20,4,31) and active')).rows[0].n,3);
 assert.equal((await db.query('select count(*)::int n from match')).rows[0].n,0,'nenhum par criado/alterado');
 assert.deepEqual((await adminPost(actor,legacyChange.POST,'/api/admin/change',{action:'remove-demo'})).json,{status:'1 mentoras de demonstração desativadas.'});
 assert.deepEqual((await db.query('select id::int,active from mentor where demo order by id')).rows,[{id:3,active:false},{id:4,active:true}],'demo vinculada a admin fica intacta');
 assert.equal(await decideAs(1,2,'approve'),'422','fluxo comum: aprovação sem turma foi substituída pela reserva v1 (CONTRATOS §7)');
 assert.equal((await db.query('select count(*)::int n from match')).rows[0].n,0);
 // authenticate: wrapper de identidade, sem sessão sem estado nem sessão viva
 const alive=(await db.query('select count(*)::int n from auth_session where revoked_at is null')).rows[0].n;
 assert.deepEqual(await service.authenticate(admin.email,pw),{email:'dona@example.invalid',role:'owner'});
 assert.equal(await service.authenticate(admin.email,pw+'x'),null);
 const common=await addUser(db,{email:'comum@example.invalid',password:pw});assert.equal(await service.authenticate(common.email,pw),null);
 assert.equal((await db.query('select count(*)::int n from auth_session where revoked_at is null')).rows[0].n,alive,'authenticate não deixa sessão viva');
 void email;void sessionFor;void tokenDigest;void (null as unknown as Pool);void useOwnerPool;
}));

test('adapters legados: elevação offline segura o lock de app_user; deactivate/decide/change/remove-demo esperam e viram 404 sem mutação',async()=>withDb(async({db,url})=>{
 const u=await addUser(db,{email:'elev@example.invalid',password:synthetic(),roles:['participant','mentor']});const actor=await actorOf(db,['admin']);
 const insP=(id:number,addr:string,userId:string|null=null)=>db.query("insert into participant(id,email,goal,moment,interests,skills,area,token_hash,consent_version,user_id) values($1,$2,'growth','working','[\"dados\"]','[\"analise\"]','dados',$3,'v0',$4)",[id,addr,String(id).padStart(64,'b'),userId]);
 const insM=(id:number,addr:string,opts:{demo?:boolean;userId?:string|null}={})=>db.query("insert into mentor(id,email,trajectory,specialties,availability,capacity,active,demo,demo_name,user_id) values($1,$2,'t','[\"dados\"]','a',3,true,$3,$4,$5)",[id,addr,opts.demo??false,opts.demo?`Demo ${id}`:null,opts.userId??null]);
 await insP(1,'p1@example.invalid');await insP(2,'p2@example.invalid');await insP(10,u.email,u.id);
 await insM(20,u.email,{userId:u.id});await insM(21,'Elev@Example.invalid',{demo:true});await insM(22,' ELEV@example.invalid ');await insM(23,'demo.livre@example.invalid',{demo:true});
 const status=async(r:Promise<Reply>)=>{const x=await r;return x.status===200?x.json:String(x.status);};
 const change=(body:Record<string,unknown>)=>status(adminPost(actor,legacyChange.POST,'/api/admin/change',body));
 const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
 let pending:Promise<unknown[]>=Promise.resolve([]);
 const elevated=await runPrivilegedAccount(['grant-admin','--user-id',u.id,'--confirm'],{MIGRATION_DATABASE_URL:url},{afterLock:async()=>{
  pending=Promise.all([change({mentorId:20,action:'deactivate'}),change({mentorId:22,action:'deactivate'}),status(adminPost(actor,legacyDecide.POST,'/api/admin/decide',{participantId:1,mentorId:20,action:'reject'})),
   change({participantId:2,mentorId:20,action:'reassign'}),change({participantId:10,action:'cancel'}),change({action:'remove-demo'})]);
  await sleep(600);
 }});
 assert.deepEqual(elevated,{code:'ok'});
 assert.deepEqual(await pending,['404','404','404','404','404',{status:'1 mentoras de demonstração desativadas.'}],'quem esperava o lock enxerga o dono já protegido');
 assert.deepEqual((await db.query('select id::int,active from mentor order by id')).rows,[{id:20,active:true},{id:21,active:true},{id:22,active:true},{id:23,active:false}]);
 assert.equal((await db.query('select count(*)::int n from match')).rows[0].n,0,'nenhum par criado');
}));
