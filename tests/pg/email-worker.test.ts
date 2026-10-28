import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {migrate} from '../../scripts/migration/migrate';
import {closeDb,hashPassword,tokenDigest} from '../../src/lib/db';
import * as identity from '../../src/lib/identity';
import * as email from '../../src/lib/email';
import * as accounts from '../../src/lib/accounts';
import {sessionFor} from './identity-harness.test';
import {pendingParticipant} from './pending-participant';

const base=process.env.MIGRATION_DATABASE_URL;
type Ctx={db:Pool;url:string;mailer:Pool};
const synthetic=()=>`pw-${randomBytes(12).toString('base64url')}`;
const roleUrl=(url:string,role:string)=>{const u=new URL(url);u.searchParams.set('options',`-c role=${role} -c jit=off`);return u.toString();};

/** App roda como techwoman_runtime, worker como techwoman_mailer (SET ROLE na conexão), fixtures como dono. */
/** Espera os backends encerrarem antes do DROP: derrubar socket ainda fechando gera erro assíncrono após o teste. */
const settled=async(control:Pool,name:string)=>{for(let i=0;i<60;i++){if(!(await control.query('select 1 from pg_stat_activity where datname=$1',[name])).rowCount)return;await new Promise(r=>setTimeout(r,50));}};
async function withDb(fn:(ctx:Ctx)=>Promise<void>){
 assert.ok(base,'MIGRATION_DATABASE_URL');const control=new Pool({connectionString:base});const name='tw_mail_'+randomUUID().replace(/-/g,'');
 const created:string[]=[];
 for(const role of ['techwoman_runtime','techwoman_mailer']){ if(!(await control.query('select 1 from pg_roles where rolname=$1',[role])).rowCount){await control.query(`create role ${role} nologin`);created.push(role);} }
 await control.query(`create database ${name}`);const u=new URL(base);u.pathname='/'+name;const url=u.toString();
 const db=new Pool({connectionString:url,max:6,options:'-c jit=off'});const mailer=new Pool({connectionString:roleUrl(url,'techwoman_mailer'),max:4});
 const saved={d:process.env.DATABASE_URL,m:process.env.MAILER_DATABASE_URL};
 fixture=db;
 try{ await migrate(url);await closeDb();await email.closeEmailPool();process.env.DATABASE_URL=roleUrl(url,'techwoman_runtime');process.env.MAILER_DATABASE_URL=roleUrl(url,'techwoman_mailer');await fn({db,url,mailer}); }
 finally{ await closeDb();await email.closeEmailPool();for(const [k,v] of [['DATABASE_URL',saved.d],['MAILER_DATABASE_URL',saved.m]] as const){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await mailer.end();await db.end();await settled(control,name);await control.query(`drop database ${name} with (force)`);for(const role of created)await control.query(`drop role if exists ${role}`).catch(()=>undefined);await control.end(); }
}
/** Conta pendente legada (cadastro anterior à migration 31): job 'registration' para o worker; o cadastro público atual não enfileira e-mail. */
let fixture:Pool;
const register=(addr:string)=>pendingParticipant(fixture,addr);
const capture=()=>{const messages:email.EmailMessage[]=[];return {messages,transport:email.createMemoryTransport(m=>{messages.push(m);})};};
const failing=(error:()=>Error)=>email.createMemoryTransport(()=>{throw error();});
async function addUser(db:Pool,opts:{email?:string;status?:string;password?:string;roles?:string[]}={}){
 const id=randomUUID(),addr=opts.email??`u-${id.slice(0,8)}@example.invalid`;
 await db.query("insert into app_user(id,email,status,password_hash) values($1,$2,$3,$4)",[id,addr,opts.status??'active',opts.password?await hashPassword(opts.password):null]);
 for(const role of opts.roles??['participant'])await db.query('insert into user_role(user_id,role) values($1,$2)',[id,role]);
 return {id,email:addr};
}
const addJob=async(db:Pool,userId:string,kind:string,status='queued',extra:{gen?:number;attempts?:number;lease?:boolean}={})=>{const id=randomUUID();
 await db.query("insert into email_job(id,user_id,kind,generation,status,attempts,lease_until,lease_owner,dedupe_key) values($1::uuid,$2,$3,$4,$5,$6,$7,$8,$1::uuid::text)",[id,userId,kind,extra.gen??0,status,extra.attempts??0,extra.lease?new Date(Date.now()+60000):null,extra.lease?randomUUID():null]);return id;};
const jobStatus=async(db:Pool,id:string)=>(await db.query('select status from email_job where id=$1',[id])).rows[0].status as string;
const userRow=async(db:Pool,id:string)=>(await db.query('select credential_generation::int g,session_version::int sv,must_change_password m,status,password_hash is not null ph,temporary_password_hash is not null th from app_user where id=$1',[id])).rows[0];
const pwHash=async(db:Pool,id:string)=>(await db.query('select password_hash h from app_user where id=$1',[id])).rows[0].h as string|null;
const idByEmail=async(db:Pool,addr:string)=>(await db.query('select id from app_user where email_key=lower(btrim($1))',[addr])).rows[0].id as string;
/** Varre toda linha de todas as tabelas (public, internal, legacy_snapshot); só devolve boolean. */
const leaked=async(db:Pool,secrets:string[])=>{
 const tables=(await db.query("select table_schema s,table_name t from information_schema.tables where table_schema in ('public','internal','legacy_snapshot') and table_type='BASE TABLE'")).rows;
 for(const {s,t} of tables){const dump=JSON.stringify((await db.query(`select to_jsonb(x)::text j from ${s}.${t} x`)).rows);if(secrets.some(v=>v.length>0&&dump.includes(v)))return true;}
 return false;
};
/** Reenvio administrativo pelo caminho real (ator admin com sessão); devolve o job ou null. */
const resend=async(db:Pool,userId:string)=>{const actor=await addUser(db,{roles:['admin'],password:synthetic()});const r=await accounts.resendTemporary(await sessionFor(db,actor.id),userId,randomUUID());return r.outcome==='ok'?r.job??null:null;};
const zero:email.EmailWorkerResult={claimed:0,accepted:0,simulated:0,unconfirmed:0,failed:0,cancelled:0,stale:0};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

test('fluxo: cadastro neutro → worker fake → login limitado → troca → sessão full; sem segredo persistido',async()=>withDb(async({db})=>{
 await register('Fluxo@Example.invalid');const {messages,transport}=capture();
 const result=await email.runEmailWorkerOnce(transport);
 assert.deepEqual(result,{...zero,claimed:1,simulated:1});assert.equal(messages.length,1);
 const m=messages[0];assert.deepEqual([m.kind,m.to,m.text.includes(m.secret),m.secret.length>=32],['registration','Fluxo@Example.invalid',true,true]);
 const uid=await idByEmail(db,m.to);
 const attempt=(await db.query('select status,provider_id,error_code,generation::int g,completed_at is not null done from email_delivery_attempt')).rows;assert.deepEqual(attempt,[{status:'simulated',provider_id:null,error_code:null,g:1,done:true}]);
 assert.deepEqual((await db.query('select status,attempts,generation::int g,lease_owner is null lo from email_job where user_id=$1',[uid])).rows,[{status:'simulated',attempts:1,g:1,lo:true}]);
 assert.deepEqual(await userRow(db,uid),{g:1,sv:1,m:true,status:'pending_activation',ph:false,th:true});
 const limited=await identity.login(m.to,m.secret);assert.ok(limited);assert.equal(limited.state,'password_change_required');
 const fresh=synthetic();const full=await identity.changePassword(limited.token,m.secret,fresh);
 const s=await identity.identitySession(full.token);assert.ok(s);assert.deepEqual([s.scope,s.roles],['full',['participant']]);
 assert.equal((await db.query("select status from app_user where id=$1",[uid])).rows[0].status,'active');
 assert.deepEqual(await email.runEmailWorkerOnce(capture().transport),zero,'nada mais a enviar');
 assert.equal(await leaked(db,[m.secret,limited.token,full.token,fresh]),false);
 assert.equal(email.emailJobLabel('simulated').startsWith('NÃO ENVIADA'),true);
 assert.equal(/não confirmada/i.test(email.emailJobLabel('accepted'))&&!/entregue/i.test(email.emailJobLabel('accepted').replace(/não confirmada/i,'')),true,'aceite ≠ entrega');
}));

test('dois workers concorrentes: nenhuma emissão duplicada e nunca duas tentativas simultâneas do mesmo usuário',async()=>withDb(async({db})=>{
 for(let i=0;i<8;i++)await register(`c${i}@example.invalid`);
 const seen:email.EmailMessage[]=[];const inflight=new Set<string>();let overlap=false;
 const make=()=>email.createMemoryTransport(async m=>{if(inflight.has(m.to))overlap=true;inflight.add(m.to);seen.push(m);await sleep(60);inflight.delete(m.to);});
 const [a,b]=await Promise.all([email.runEmailWorkerOnce(make(),randomUUID()),email.runEmailWorkerOnce(make(),randomUUID())]);
 assert.equal(a.claimed+b.claimed,8);assert.equal(a.simulated+b.simulated,8);assert.equal(new Set(seen.map(m=>m.jobId)).size,8);assert.equal(new Set(seen.map(m=>m.to)).size,8);assert.equal(overlap,false);
 assert.equal((await db.query("select count(*)::int n from email_job where status='simulated' and attempts=1")).rows[0].n,8);
 // mesmo usuário com duas intenções: serializadas, a última emissão vence
 const user=await register('dupla@example.invalid').then(()=>idByEmail(db,'dupla@example.invalid'));
 assert.ok(await resend(db,user));
 const got:email.EmailMessage[]=[];let clash=false,live=0;
 const slow=()=>email.createMemoryTransport(async m=>{live++;if(live>1)clash=true;got.push(m);await sleep(120);live--;});
 await Promise.all([email.runEmailWorkerOnce(slow(),randomUUID()),email.runEmailWorkerOnce(slow(),randomUUID())]);
 assert.equal(clash,false);assert.equal(got.length,2);assert.equal(new Set(got.map(m=>m.jobId)).size,2);
 assert.equal(await identity.login('dupla@example.invalid',got[0].secret),null,'emissão anterior foi substituída');assert.ok(await identity.login('dupla@example.invalid',got[1].secret));
}));

test('R4: timeout depois do aceite, com login e troca concluídos, e novo worker NÃO reemite nem revoga a senha concluída',async()=>withDb(async({db})=>{
 await register('r4@example.invalid');const newPw=synthetic();const seen={session:'',ok:false};
 const crash=email.createMemoryTransport(async m=>{const lim=await identity.login(m.to,m.secret);if(!lim)return;const done=await identity.changePassword(lim.token,m.secret,newPw);seen.session=done.token;seen.ok=true;throw new Error('socket timeout após aceite');});
 const first=await email.runEmailWorkerOnce(crash);assert.equal(seen.ok,true);assert.deepEqual(first,{...zero,claimed:1,stale:1});
 const uid=await idByEmail(db,'r4@example.invalid');const before=await userRow(db,uid);const hashBefore=await pwHash(db,uid);
 assert.equal(await jobStatus(db,(await db.query('select id from email_job')).rows[0].id),'cancelled');
 assert.deepEqual((await db.query('select status,error_code from email_delivery_attempt')).rows,[{status:'unconfirmed',error_code:'TRANSPORT_ERROR'}],'tentativa registrada com código sanitizado');
 await db.query("update email_job set next_attempt_at=now()-interval '1 second',lease_until=now()-interval '1 second'");
 const later=capture();const second=await email.runEmailWorkerOnce(later.transport);
 assert.deepEqual([second,later.messages.length],[zero,0]);
 assert.deepEqual(await userRow(db,uid),before);assert.equal((await pwHash(db,uid))===hashBefore,true);
 assert.ok(await identity.identitySession(seen.session),'sessão concluída continua válida');assert.ok(await identity.login('r4@example.invalid',newPw));
}));

test('R4: timeout depois de login limitado (sem troca) cancela o job; retry não reemite o temporário consumido',async()=>withDb(async({db})=>{
 await register('lim@example.invalid');let limited='',secret='';
 await email.runEmailWorkerOnce(email.createMemoryTransport(async m=>{const l=await identity.login(m.to,m.secret);limited=l?.token??'';secret=m.secret;throw new email.TransportError('TRANSPORT_TIMEOUT');}));
 const uid=await idByEmail(db,'lim@example.invalid');const before=await userRow(db,uid);
 await db.query("update email_job set next_attempt_at=now()-interval '1 second',lease_until=now()-interval '1 second'");
 const later=capture();assert.deepEqual(await email.runEmailWorkerOnce(later.transport),zero);assert.equal(later.messages.length,0);
 assert.deepEqual(await userRow(db,uid),before);const s=await identity.identitySession(limited);assert.ok(s);
 const fresh=synthetic();await identity.changePassword(limited,secret,fresh);assert.ok(await identity.login('lim@example.invalid',fresh));
}));

test('retry legítimo: backoff 1min/5min, máximo 3 tentativas, segredo novo a cada emissão, erro sanitizado',async()=>withDb(async({db})=>{
 await register('retry@example.invalid');const uid=await idByEmail(db,'retry@example.invalid');
 const poison='senha-secreta-no-erro-9f3a';
 const t1=await email.runEmailWorkerOnce(failing(()=>new Error(poison)));assert.deepEqual(t1,{...zero,claimed:1,unconfirmed:1});
 const j=async()=>(await db.query("select status,attempts,extract(epoch from next_attempt_at-now())::int wait,lease_owner is null lo from email_job where user_id=$1",[uid])).rows[0];
 let row=await j();assert.deepEqual([row.status,row.attempts,row.lo],['unconfirmed',1,true]);assert.equal(row.wait>50&&row.wait<=60,true);
 assert.deepEqual(await email.runEmailWorkerOnce(capture().transport),zero,'ainda não venceu');
 await db.query("update email_job set next_attempt_at=now()-interval '1 second'");
 const first=capture();
 await email.runEmailWorkerOnce(email.createMemoryTransport(async m=>{first.messages.push(m);throw new email.TransportError('TRANSPORT_TIMEOUT');}));
 row=await j();assert.deepEqual([row.status,row.attempts],['unconfirmed',2]);assert.equal(row.wait>270&&row.wait<=300,true,'segundo retry em 5min');
 await db.query("update email_job set next_attempt_at=now()-interval '1 second'");
 const last=capture();const done=await email.runEmailWorkerOnce(email.createMemoryTransport(async m=>{last.messages.push(m);throw new email.TransportError('TRANSPORT_TIMEOUT');}));
 assert.deepEqual(done,{...zero,claimed:1,failed:1});row=await j();assert.deepEqual([row.status,row.attempts,row.wait],['failed',3,null],'terceira tentativa sem confirmação vira failed (retry 1min e 5min, depois failed)');
 await db.query("update email_job set lease_until=now()-interval '1 second'");assert.deepEqual(await email.runEmailWorkerOnce(capture().transport),zero,'esgotado');
 assert.equal(first.messages[0].secret===last.messages[0].secret,false);
 assert.equal(await identity.login('retry@example.invalid',first.messages[0].secret),null,'segredo antigo foi substituído');assert.ok(await identity.login('retry@example.invalid',last.messages[0].secret));
 const codes=(await db.query('select error_code,status from email_delivery_attempt order by created_at')).rows;
 assert.deepEqual(codes.map(c=>[c.status,c.error_code]),[['unconfirmed','TRANSPORT_ERROR'],['unconfirmed','TRANSPORT_TIMEOUT'],['failed','TRANSPORT_TIMEOUT']]);
 assert.equal(await leaked(db,[poison,first.messages[0].secret,last.messages[0].secret]),false);
}));

test('rejeição definitiva do transporte marca failed sem retry; aceite guarda só provider_id',async()=>withDb(async({db})=>{
 await register('rej@example.invalid');
 assert.deepEqual(await email.runEmailWorkerOnce(failing(()=>new email.TransportError('RECIPIENT_NOT_ALLOWED'))),{...zero,claimed:1,failed:1});
 assert.deepEqual((await db.query('select status,attempts from email_job')).rows,[{status:'failed',attempts:1}]);
 assert.deepEqual((await db.query('select status,error_code from email_delivery_attempt')).rows,[{status:'failed',error_code:'RECIPIENT_NOT_ALLOWED'}]);
 await register('ok@example.invalid');
 const accepting:email.EmailTransport={name:'x',async send(){return {status:'accepted',providerId:'0100019abc-def_123@email.amazonses.com'};}};
 assert.deepEqual(await email.runEmailWorkerOnce(accepting),{...zero,claimed:1,accepted:1});
 assert.deepEqual((await db.query("select a.status,a.provider_id from email_delivery_attempt a join email_job j on j.id=a.job_id where j.status='accepted'")).rows,[{status:'accepted',provider_id:'0100019abc-def_123@email.amazonses.com'}]);
}));

test('revalida usuário, destino e proteção de admin antes de emitir',async()=>withDb(async({db})=>{
 await register('antes@example.invalid');const uid=await idByEmail(db,'antes@example.invalid');
 await db.query("update app_user set email='Depois@Example.invalid' where id=$1",[uid]);
 const moved=capture();await email.runEmailWorkerOnce(moved.transport);assert.deepEqual(moved.messages.map(m=>m.to),['Depois@Example.invalid'],'destino relido no momento do envio');
 const pw=synthetic();
 const disabled=await addUser(db,{password:pw,status:'disabled'}),admin=await addUser(db,{password:pw,roles:['admin','mentor']}),team=await addUser(db,{password:pw,roles:['team']}),pendingAdmin=await addUser(db,{status:'pending_activation',roles:['admin']});
 const active=await addUser(db,{password:pw});
 const jobs=[await addJob(db,disabled.id,'temporary_password'),await addJob(db,admin.id,'temporary_password'),await addJob(db,team.id,'registration'),await addJob(db,pendingAdmin.id,'registration'),await addJob(db,active.id,'registration'),await addJob(db,disabled.id,'password_reset')];
 const states=await Promise.all([admin,team,disabled,active].map(u=>userRow(db,u.id)));
 const hashes=await Promise.all([admin,team,disabled,active].map(u=>pwHash(db,u.id)));
 const quiet=capture();const result=await email.runEmailWorkerOnce(quiet.transport);
 assert.deepEqual(result,{...zero,claimed:6,cancelled:6});assert.equal(quiet.messages.length,0);
 for(const id of jobs)assert.equal(await jobStatus(db,id),'cancelled');
 assert.deepEqual(await Promise.all([admin,team,disabled,active].map(u=>userRow(db,u.id))),states,'nenhuma credencial emitida/alterada');
 assert.deepEqual(await Promise.all([admin,team,disabled,active].map(u=>pwHash(db,u.id))),hashes);
 assert.equal((await db.query('select count(*)::int n from email_delivery_attempt where job_id=any($1::uuid[])',[jobs])).rows[0].n,0);
}));

test('reenvio explícito emite temporário para usuária ativa e revoga sessões; reset emite token sem revogar nada',async()=>withDb(async({db})=>{
 const pw=synthetic();const user=await addUser(db,{password:pw});const s=await identity.login(user.email,pw);assert.ok(s);
 await identity.requestPasswordForgot(user.email);const reset=capture();await email.runEmailWorkerOnce(reset.transport);
 assert.equal(reset.messages.length,1);const rm=reset.messages[0];assert.deepEqual([rm.kind,rm.to,/^[A-Za-z0-9_-]{43}$/.test(rm.secret)],['password_reset',user.email,true]);
 assert.ok(await identity.identitySession(s.token),'forgot/emissão do token não revogam sessão');assert.ok(await identity.login(user.email,pw));
 const tok=(await db.query('select token_hash,generation::int g,expires_at-now()<=interval \'30 minutes\' ok,used_at is null u from password_reset_token')).rows;
 assert.deepEqual([tok.length,tok[0].token_hash===tokenDigest(rm.secret),tok[0].ok,tok[0].u],[1,true,true,true]);
 assert.equal(tok[0].g,(await userRow(db,user.id)).g);
 const sent=await resend(db,user.id);assert.ok(sent);
 const g0=(await userRow(db,user.id)).g;const temp=capture();await email.runEmailWorkerOnce(temp.transport);
 assert.equal(temp.messages.length,1);assert.equal(temp.messages[0].kind,'temporary_password');
 assert.equal(await identity.identitySession(s.token),null,'emissão explícita revoga sessões anteriores');assert.equal(await identity.login(user.email,pw),null,'senha definitiva suspensa enquanto temporário pendente');
 assert.equal((await userRow(db,user.id)).g>g0,true);
 assert.equal(await jobStatus(db,sent.jobId),'simulated');
 await assert.rejects(()=>identity.confirmPasswordReset(rm.secret,synthetic()),(e:unknown)=>e instanceof identity.IdentityError&&e.code==='INVALID_RESET','temporário novo invalidou o token de reset antigo (geração)');
 assert.ok(await identity.login(user.email,temp.messages[0].secret));
}));

test('reset: admin com prova por e-mail, retry com token novo, troca no meio cancela, uso único e simultâneo',async()=>withDb(async({db})=>{
 const pw=synthetic();const admin=await addUser(db,{password:pw,roles:['admin']});
 await identity.requestPasswordForgot(admin.email);
 const first=capture();await email.runEmailWorkerOnce(email.createMemoryTransport(async m=>{first.messages.push(m);throw new email.TransportError('TRANSPORT_TIMEOUT');}));
 await db.query("update email_job set next_attempt_at=now()-interval '1 second'");const second=capture();await email.runEmailWorkerOnce(second.transport);
 assert.equal(second.messages.length,1);assert.equal(first.messages[0].secret===second.messages[0].secret,false);
 await assert.rejects(()=>identity.confirmPasswordReset(first.messages[0].secret,synthetic()),(e:unknown)=>e instanceof identity.IdentityError&&e.code==='INVALID_RESET');
 const [a,b]=[synthetic(),synthetic()];
 const results=await Promise.allSettled([identity.confirmPasswordReset(second.messages[0].secret,a),identity.confirmPasswordReset(second.messages[0].secret,b)]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 const winner=results[0].status==='fulfilled'?a:b;assert.ok(await identity.login(admin.email,winner));
 await assert.rejects(()=>identity.confirmPasswordReset(second.messages[0].secret,synthetic()),(e:unknown)=>e instanceof identity.IdentityError);
 // troca de senha entre tentativas cancela o retry
 const user=await addUser(db,{password:pw});await identity.requestPasswordForgot(user.email);
 await email.runEmailWorkerOnce(failing(()=>new email.TransportError('TRANSPORT_TIMEOUT')));
 const s=await identity.login(user.email,pw);assert.ok(s);const done=await identity.changePassword(s.token,pw,synthetic());
 await db.query("update email_job set next_attempt_at=now()-interval '1 second' where user_id=$1",[user.id]);
 const late=capture();assert.deepEqual(await email.runEmailWorkerOnce(late.transport),zero);assert.equal(late.messages.length,0);assert.ok(await identity.identitySession(done.token));
 // reset expirado: retry cancelado
 const old=await addUser(db,{password:pw});await identity.requestPasswordForgot(old.email);
 await email.runEmailWorkerOnce(failing(()=>new email.TransportError('TRANSPORT_TIMEOUT')));
 await db.query("update password_reset_token set expires_at=now()-interval '1 second' where user_id=$1",[old.id]);await db.query("update email_job set next_attempt_at=now()-interval '1 second' where user_id=$1",[old.id]);
 const none=capture();await email.runEmailWorkerOnce(none.transport);assert.equal(none.messages.length,0);
 assert.equal((await db.query("select status from email_job where user_id=$1",[old.id])).rows[0].status,'cancelled');
}));

test('regressão Task1+R4: login/troca/reset cancelam também jobs em sending; login full só cancela automáticos',async()=>withDb(async({db})=>{
 const pw=synthetic();
 // consumo do temporário cancela temp em queued/sending/unconfirmed (e não reset/reserva)
 const pending=await addUser(db,{status:'pending_activation'});
 const t=identity.generateTemporaryPassword();await db.query('select internal.issue_temporary_credential($1::uuid,$2)',[pending.id,await hashPassword(t)]);
 const q=[await addJob(db,pending.id,'registration','queued'),await addJob(db,pending.id,'temporary_password','sending',{lease:true}),await addJob(db,pending.id,'registration','unconfirmed',{attempts:1})];
 const keep=[await addJob(db,pending.id,'password_reset','sending',{lease:true}),await addJob(db,pending.id,'reservation','queued')];
 const lim=await identity.login(pending.email,t);assert.ok(lim);
 assert.deepEqual(await Promise.all(q.map(i=>jobStatus(db,i))),['cancelled','cancelled','cancelled']);assert.deepEqual(await Promise.all(keep.map(i=>jobStatus(db,i))),['sending','queued']);
 assert.equal((await db.query('select count(*)::int n from email_job where status=\'cancelled\' and lease_owner is not null')).rows[0].n,0);
 const sending=await addJob(db,pending.id,'password_reset','sending',{lease:true});
 await identity.changePassword(lim.token,t,synthetic());
 assert.deepEqual(await Promise.all([...keep.slice(0,1),sending].map(i=>jobStatus(db,i))),['cancelled','cancelled']);assert.equal(await jobStatus(db,keep[1]),'queued');
 // login full: cancela só automáticos (kind registration) obsoletos; reenvio explícito e reset seguem
 const user=await addUser(db,{password:pw});
 const auto=[await addJob(db,user.id,'registration','queued'),await addJob(db,user.id,'registration','sending',{lease:true}),await addJob(db,user.id,'registration','unconfirmed',{attempts:1})];
 const explicit=await addJob(db,user.id,'temporary_password','queued'),reset=await addJob(db,user.id,'password_reset','queued');
 assert.ok(await identity.login(user.email,pw));
 assert.deepEqual(await Promise.all(auto.map(i=>jobStatus(db,i))),['cancelled','cancelled','cancelled']);assert.equal(await jobStatus(db,explicit),'queued','reenvio explícito é intenção distinta');assert.equal(await jobStatus(db,reset),'queued');
 // reset consumido cancela tudo de credencial, inclusive sending
 const r=await addUser(db,{password:pw});const rj=[await addJob(db,r.id,'password_reset','sending',{lease:true}),await addJob(db,r.id,'temporary_password','sending',{lease:true}),await addJob(db,r.id,'registration','queued')];
 const token=identity.generateResetToken();await db.query('select internal.issue_reset_token($1::uuid,$2)',[r.id,tokenDigest(token)]);
 await identity.confirmPasswordReset(token,synthetic());assert.deepEqual(await Promise.all(rj.map(i=>jobStatus(db,i))),['cancelled','cancelled','cancelled']);
}));

test('crash após commit da emissão: lease expira, segredo nunca está no banco; retry sem consumo reemite, com consumo não',async()=>withDb(async({db,mailer})=>{
 const crashAfterBegin=async(addr:string)=>{
  await register(addr);const owner=randomUUID();
  const claim=(await mailer.query('select * from internal.email_claim($1::uuid)',[owner])).rows;assert.equal(claim.length,1);
  const secret=identity.generateTemporaryPassword();
  const begin=(await mailer.query('select * from internal.email_emit_begin($1::uuid,$2::uuid,$3)',[claim[0].job_id,owner,await hashPassword(secret)])).rows[0];
  assert.deepEqual([begin.outcome,begin.destination,begin.kind],['issued',addr,'registration']);
  return {secret,job:claim[0].job_id as string};
 };
 const a=await crashAfterBegin('crash1@example.invalid');
 assert.equal(await leaked(db,[a.secret]),false);
 assert.equal((await db.query('select status,attempts from email_job where id=$1',[a.job])).rows[0].status,'sending');
 const blocked=capture();assert.deepEqual(await email.runEmailWorkerOnce(blocked.transport),zero,'lease vivo bloqueia outro worker');
 await db.query("update email_job set lease_until=now()-interval '1 second' where id=$1",[a.job]);
 const retry=capture();assert.deepEqual(await email.runEmailWorkerOnce(retry.transport),{...zero,claimed:1,simulated:1});
 assert.equal(retry.messages[0].secret===a.secret,false);assert.equal(await identity.login('crash1@example.invalid',a.secret),null);assert.ok(await identity.login('crash1@example.invalid',retry.messages[0].secret));
 const b=await crashAfterBegin('crash2@example.invalid');
 const lim=await identity.login('crash2@example.invalid',b.secret);assert.ok(lim);
 assert.equal((await db.query('select status from email_job where id=$1',[b.job])).rows[0].status,'cancelled');
 const pwNew=synthetic();await identity.changePassword(lim.token,b.secret,pwNew);
 await db.query("update email_job set lease_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second' where id=$1",[b.job]);
 const after=capture();const uid=await idByEmail(db,'crash2@example.invalid');const st=await userRow(db,uid);
 assert.deepEqual(await email.runEmailWorkerOnce(after.transport),zero);assert.deepEqual(await userRow(db,uid),st);assert.ok(await identity.login('crash2@example.invalid',pwNew));
 assert.equal(await leaked(db,[b.secret,pwNew]),false);
}));

test('fronteira do mailer: só funções de fila; formato de hash e posse do lease são exigidos; runtime não toca a fila',async()=>withDb(async({db,mailer})=>{
 const as=async(role:string,sql:string,params:unknown[]=[])=>{const c=await db.connect();try{await c.query(`set role ${role}`);await c.query(sql,params);return true}catch{return false}finally{await c.query('reset role').catch(()=>undefined);c.release()}};
 assert.equal(await as('techwoman_mailer','select * from internal.email_claim(gen_random_uuid())'),true);
 await register('prv@example.invalid');const uid=await idByEmail(db,'prv@example.invalid');
 for(const sql of ['select * from app_user','update app_user set status=\'active\'','select * from user_role','select * from auth_session','select * from password_reset_token','insert into user_role(user_id,role) values(gen_random_uuid(),\'admin\')',"select internal.register_participant_account('a@example.invalid','x','growth','working','[]','[]','x',1)",'select * from internal.identity_login_begin(\'a@example.invalid\')'])
  assert.equal(await as('techwoman_mailer',sql),false,'mailer: '+sql);
 for(const sql of ['select * from internal.email_claim(gen_random_uuid())','select * from internal.email_emit_begin(gen_random_uuid(),gen_random_uuid(),\'x\')','select internal.email_emit_finish(gen_random_uuid(),gen_random_uuid(),gen_random_uuid(),\'accepted\',null,null)','select * from email_job','update email_job set status=\'queued\''])
  assert.equal(await as('techwoman_runtime',sql),false,'runtime: '+sql);
 const defs=(await db.query("select p.proname,p.prosecdef,p.proconfig::text cfg,has_function_privilege('public',p.oid,'execute') pub from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='internal' and p.proname in ('email_claim','email_emit_begin','email_emit_finish','request_password_forgot','enqueue_admin_temporary')")).rows;
 assert.equal(defs.length,5);for(const d of defs){assert.deepEqual([d.prosecdef,/search_path=pg_catalog, pg_temp/.test(d.cfg),d.pub],[true,true,false],d.proname);}
 const owner=randomUUID();const claim=(await mailer.query('select * from internal.email_claim($1::uuid)',[owner])).rows[0];assert.ok(claim);
 const row=async(sql:string,params:unknown[])=>{try{return (await mailer.query(sql,params)).rows[0]}catch{return 'ERROR'}};
 const before=await userRow(db,uid);
 const bad=await row('select * from internal.email_emit_begin($1::uuid,$2::uuid,$3)',[claim.job_id,owner,'senha-em-texto-claro']);assert.equal(bad==='ERROR'||bad?.outcome!=='issued',true,'hash fora do formato scrypt é recusado');
 const wrong=await row('select * from internal.email_emit_begin($1::uuid,$2::uuid,$3)',[claim.job_id,randomUUID(),await hashPassword(synthetic())]);assert.equal(wrong==='ERROR'||wrong?.outcome==='lost',true,'quem não detém o lease não emite');
 assert.deepEqual(await userRow(db,uid),before);
 const finish=await row('select internal.email_emit_finish($1::uuid,$2::uuid,gen_random_uuid(),\'accepted\',null,null) r',[claim.job_id,randomUUID()]);assert.equal(finish==='ERROR'||finish?.r==='stale',true);
 assert.equal((await db.query('select status from email_job')).rows[0].status,'sending');
}));

test('sem deadlock: cadastros, logins, trocas, resets, reenvios e dois workers em paralelo',async()=>withDb(async({db})=>{
 const pw=synthetic();const users=[];for(let i=0;i<6;i++)users.push(await addUser(db,{password:pw}));
 const pend=[];for(let i=0;i<6;i++){await register(`p${i}@example.invalid`);pend.push(`p${i}@example.invalid`);}
 for(const u of users)await identity.requestPasswordForgot(u.email);
 const ops:Promise<unknown>[]=[];
 for(const u of users){ops.push(identity.login(u.email,pw));ops.push(resend(db,u.id));ops.push(identity.requestPasswordForgot(u.email));}
 for(const addr of pend)ops.push(identity.requestPasswordForgot(addr));
 ops.push(email.runEmailWorkerOnce(capture().transport),email.runEmailWorkerOnce(capture().transport));
 const settled=await Promise.allSettled(ops);assert.equal(settled.filter(r=>r.status==='rejected').length,0);
 for(let i=0;i<3;i++)await Promise.all([email.runEmailWorkerOnce(capture().transport),email.runEmailWorkerOnce(capture().transport)]);
 assert.equal((await db.query("select count(*)::int n from email_job where status in ('queued','sending')")).rows[0].n,0);
}));

test('I1: forgot em pending_activation não destrói ativação em andamento (temporário consumido com sessão limitada viva)',async()=>withDb(async({db})=>{
 await register('ativ@example.invalid');const first=capture();await email.runEmailWorkerOnce(first.transport);
 const m=first.messages[0];const uid=await idByEmail(db,m.to);
 const limited=await identity.login(m.to,m.secret);assert.ok(limited);const before=await userRow(db,uid);
 assert.deepEqual(await identity.requestPasswordForgot(m.to),{status:'received'});
 assert.equal((await db.query('select count(*)::int n from email_job where user_id=$1',[uid])).rows[0].n,1,'nenhuma nova intenção enfileirada');
 const again=capture();assert.deepEqual(await email.runEmailWorkerOnce(again.transport),zero);assert.equal(again.messages.length,0);
 assert.deepEqual(await userRow(db,uid),before,'credencial e geração intactas');
 const full=await identity.changePassword(limited.token,m.secret,synthetic());assert.ok(await identity.identitySession(full.token),'troca concluída com o temporário já em uso');
}));

test('I1: job de cadastro que chega depois do consumo do temporário é cancelado já na primeira tentativa',async()=>withDb(async({db})=>{
 await register('tarde@example.invalid');const first=capture();await email.runEmailWorkerOnce(first.transport);
 const m=first.messages[0];const uid=await idByEmail(db,m.to);
 const limited=await identity.login(m.to,m.secret);assert.ok(limited);const before=await userRow(db,uid);
 const job=await addJob(db,uid,'registration','queued');
 const late=capture();assert.deepEqual(await email.runEmailWorkerOnce(late.transport),{...zero,claimed:1,cancelled:1});assert.equal(late.messages.length,0);
 assert.equal(await jobStatus(db,job),'cancelled');assert.deepEqual(await userRow(db,uid),before);
 assert.ok(await identity.identitySession(limited.token),'sessão limitada segue viva');
 const full=await identity.changePassword(limited.token,m.secret,synthetic());assert.ok(await identity.identitySession(full.token));
}));

test('I1: temporário ainda não usado e emitido há menos de 15 minutos não é reemitido por forgot; depois disso sim',async()=>withDb(async({db})=>{
 await register('recente@example.invalid');const first=capture();await email.runEmailWorkerOnce(first.transport);
 const m=first.messages[0];const uid=await idByEmail(db,m.to);
 await identity.requestPasswordForgot(m.to);
 assert.equal((await db.query('select count(*)::int n from email_job where user_id=$1',[uid])).rows[0].n,1,'reemissão limitada por taxa');
 assert.ok(await identity.login(m.to,m.secret),'o temporário original segue válido');
 const stale=await register('antigo@example.invalid').then(()=>idByEmail(db,'antigo@example.invalid'));const old=capture();await email.runEmailWorkerOnce(old.transport);
 await db.query("update app_user set temporary_expires_at=now()+interval '23 hours' where id=$1",[stale]);
 await identity.requestPasswordForgot('antigo@example.invalid');
 const next=capture();await email.runEmailWorkerOnce(next.transport);assert.equal(next.messages.length,1,'após 15 minutos o forgot volta a reemitir');
}));

test('R-spec: sending com lease vencido e 3 tentativas vira failed no claim, sem reemitir',async()=>withDb(async({db})=>{
 await register('lease@example.invalid');const uid=await idByEmail(db,'lease@example.invalid');
 await db.query("update email_job set status='sending',attempts=3,lease_owner=gen_random_uuid(),lease_until=now()-interval '1 second' where user_id=$1",[uid]);
 const t=capture();assert.deepEqual(await email.runEmailWorkerOnce(t.transport),zero);assert.equal(t.messages.length,0);
 assert.deepEqual((await db.query('select status,attempts from email_job where user_id=$1',[uid])).rows,[{status:'failed',attempts:3}]);
}));

test('R-spec: o texto orienta usar apenas o acesso mais recente (temporário e reset), com o segredo no corpo',async()=>withDb(async({db})=>{
 const phrase='use apenas o acesso mais recente';
 await register('texto@example.invalid');const temp=capture();await email.runEmailWorkerOnce(temp.transport);
 const user=await addUser(db,{password:synthetic()});await identity.requestPasswordForgot(user.email);const reset=capture();await email.runEmailWorkerOnce(reset.transport);
 assert.deepEqual([temp.messages.length,reset.messages.length],[1,1]);
 for(const msg of [temp.messages[0],reset.messages[0]])assert.deepEqual([msg.kind,msg.text.toLowerCase().includes(phrase),msg.text.includes(msg.secret)],[msg.kind,true,true]);
}));
