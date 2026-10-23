import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {migrate} from '../../scripts/migration/migrate';
import {closeDb,hashPassword,tokenDigest} from '../../src/lib/db';
import * as identity from '../../src/lib/identity';

const base=process.env.MIGRATION_DATABASE_URL;
type Ctx={db:Pool;url:string};
const synthetic=()=>`pw-${randomBytes(12).toString('base64url')}`;

async function withDb(fn:(ctx:Ctx)=>Promise<void>){
 assert.ok(base,'MIGRATION_DATABASE_URL');const control=new Pool({connectionString:base});const name='tw_ident_'+randomUUID().replace(/-/g,'');
 const created:string[]=[];
 for(const role of ['techwoman_runtime','techwoman_mailer']){ if(!(await control.query('select 1 from pg_roles where rolname=$1',[role])).rowCount){await control.query(`create role ${role} nologin`);created.push(role);} }
 await control.query(`create database ${name}`);const u=new URL(base);u.pathname='/'+name;const url=u.toString();
 const db=new Pool({connectionString:url,max:6});const previous=process.env.DATABASE_URL;
 try{ await migrate(url);process.env.DATABASE_URL=url;await closeDb();await fn({db,url}); }
 finally{ await closeDb();if(previous===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previous;await db.end();await control.query(`drop database ${name} with (force)`);for(const role of created)await control.query(`drop role if exists ${role}`).catch(()=>undefined);await control.end(); }
}
async function addUser(db:Pool,opts:{email?:string;status?:string;password?:string;hash?:string;roles?:string[]}={}){
 const id=randomUUID(),email=opts.email??`u-${id.slice(0,8)}@example.invalid`;
 const hash=opts.hash??(opts.password?await hashPassword(opts.password):null);
 await db.query("insert into app_user(id,email,status,password_hash) values($1,$2,$3,$4)",[id,email,opts.status??'active',hash]);
 for(const role of opts.roles??['participant'])await db.query('insert into user_role(user_id,role) values($1,$2)',[id,role]);
 return {id,email};
}
async function issueTemporary(db:Pool,userId:string){
 const temp=identity.generateTemporaryPassword();
 await db.query("select internal.issue_temporary_credential($1::uuid,$2)",[userId,await hashPassword(temp)]);return temp;
}
async function issueReset(db:Pool,userId:string,ttl='30 minutes'){
 const token=identity.generateResetToken();await db.query("select internal.issue_reset_token($1::uuid,$2)",[userId,tokenDigest(token)]);
 if(ttl!=='30 minutes')await db.query("update password_reset_token set expires_at=now()+$2::interval where token_hash=$1",[tokenDigest(token),ttl]);return token;
}
const code=async(p:Promise<unknown>)=>{try{await p;return null}catch(e){return e instanceof identity.IdentityError?e.code:'UNEXPECTED'}};

test('login legado: hash saltHex:digest preservado, sessão opaca só com digest no banco',async()=>withDb(async({db})=>{
 const pw=synthetic();const salt='0123456789abcdef0123456789abcdef';
 const {scryptSync}=await import('node:crypto');const legacy=`${salt}:${scryptSync(pw,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024}).toString('hex')}`;
 const user=await addUser(db,{hash:legacy,roles:['admin','mentor']});
 const ok=await identity.login(user.email.toUpperCase()+' ',pw);
 assert.ok(ok);assert.equal(ok.state,'authenticated');assert.equal(identity.isSessionToken(ok.token),true);
 const s=await identity.identitySession(ok.token);assert.ok(s);
 assert.equal(s.scope,'full');assert.equal(s.userId,user.id);assert.deepEqual([...s.roles].sort(),['admin','mentor']);assert.equal(s.state,'authenticated');
 const row=(await db.query('select token_hash,scope,expires_at-created_at as ttl from auth_session')).rows[0];
 assert.equal(row.token_hash===ok.token,false);assert.equal(row.token_hash,tokenDigest(ok.token));assert.equal(row.ttl.hours,24);
 assert.equal((await db.query('select password_hash=$2 as same from app_user where id=$1',[user.id,legacy])).rows[0].same,true,'login não faz rehash');
 assert.equal(await identity.login(user.email,pw+'x'),null);
 assert.equal(await identity.login('ninguem@example.invalid',pw),null);
 await db.query("update app_user set password_hash='nao-e-hash' where id=$1",[user.id]);assert.equal(await identity.login(user.email,pw),null);
 await db.query("update app_user set password_hash=$2,status='disabled' where id=$1",[user.id,legacy]);assert.equal(await identity.login(user.email,pw),null);
}));

test('sessão é revogável: logout, expiração, session_version e status',async()=>withDb(async({db})=>{
 const pw=synthetic();const user=await addUser(db,{password:pw});
 const a=await identity.login(user.email,pw),b=await identity.login(user.email,pw),c=await identity.login(user.email,pw);assert.ok(a&&b&&c);
 await identity.logout(a.token);assert.equal(await identity.identitySession(a.token),null);assert.ok(await identity.identitySession(b.token));
 await db.query("update auth_session set expires_at=now()-interval '1 second' where token_hash=$1",[tokenDigest(b.token)]);assert.equal(await identity.identitySession(b.token),null);
 await db.query('update app_user set session_version=session_version+1 where id=$1',[user.id]);assert.equal(await identity.identitySession(c.token),null);
 const d=await identity.login(user.email,pw);assert.ok(d);await db.query("update app_user set status='disabled' where id=$1",[user.id]);assert.equal(await identity.identitySession(d.token),null);
 assert.equal(await identity.identitySession('x'),null);assert.equal(await identity.identitySession(identity.newSessionToken()),null);
}));

test('temporário: consumo único, sessão limitada 10min, troca com hash retido revoga tudo',async()=>withDb(async({db})=>{
 const old=synthetic();const user=await addUser(db,{password:old});const fullBefore=await identity.login(user.email,old);assert.ok(fullBefore);
 const temp=await issueTemporary(db,user.id);
 const row=(await db.query('select must_change_password m,temporary_used_at u,temporary_expires_at-now()>interval \'23 hours\' long from app_user where id=$1',[user.id])).rows[0];
 assert.deepEqual([row.m,row.u,row.long],[true,null,true]);
 assert.equal(await identity.login(user.email,old),null,'senha definitiva não vale enquanto troca é exigida');
 assert.equal(await identity.login(user.email,temp+'x'),null);
 const racing=await Promise.all([identity.login(user.email,temp),identity.login(user.email,temp)]);
 assert.equal(racing.filter(Boolean).length,1,'consumo atômico');
 const first=racing.find(Boolean);assert.ok(first);assert.equal(first.state,'password_change_required');
 const lim=await identity.identitySession(first.token);assert.ok(lim);assert.equal(lim.scope,'password_change');assert.equal(lim.state,'password_change_required');
 const ttl=(await db.query("select extract(epoch from expires_at-created_at) s from auth_session where token_hash=$1",[tokenDigest(first.token)])).rows[0].s;assert.ok(ttl>0&&ttl<=600);
 assert.equal((await db.query('select temporary_used_at is not null u from app_user where id=$1',[user.id])).rows[0].u,true);
 assert.equal(await identity.login(user.email,temp),null,'temporário já consumido');
 const fresh=synthetic();
 assert.equal(await code(identity.changePassword(first.token,temp+'x',fresh)),'INVALID_CREDENTIALS');
 assert.equal(await code(identity.changePassword(first.token,temp,'curta')),'INVALID_INPUT');
 assert.equal(await code(identity.changePassword(identity.newSessionToken(),temp,fresh)),'AUTH_REQUIRED');
 assert.equal(await code(identity.changePassword(fullBefore.token,old,fresh)),'AUTH_REQUIRED','sessão antiga já foi revogada no emitir');
 const done=await identity.changePassword(first.token,temp,fresh);assert.equal(identity.isSessionToken(done.token),true);
 const s=await identity.identitySession(done.token);assert.ok(s);assert.equal(s.scope,'full');
 assert.equal(await identity.identitySession(first.token),null,'sessão limitada gasta');
 assert.equal(await code(identity.changePassword(first.token,temp,synthetic())),'AUTH_REQUIRED');
 const after=(await db.query('select temporary_password_hash is null t,temporary_expires_at is null e,temporary_used_at is null u,must_change_password m,status from app_user where id=$1',[user.id])).rows[0];
 assert.deepEqual(after,{t:true,e:true,u:true,m:false,status:'active'});
 assert.ok(await identity.login(user.email,fresh));assert.equal(await identity.login(user.email,temp),null);assert.equal(await identity.login(user.email,old),null);
}));

test('troca inicial ativa pending_activation; sessão full troca com a senha definitiva; novas senhas preservam espaços',async()=>withDb(async({db})=>{
 const user=await addUser(db,{status:'pending_activation',roles:['participant','mentor']});const temp=await issueTemporary(db,user.id);
 const lim=await identity.login(user.email,temp);assert.ok(lim);assert.equal(lim.state,'password_change_required');
 const spaced='  '+synthetic()+'  ';const done=await identity.changePassword(lim.token,temp,spaced);
 assert.equal((await db.query('select status from app_user where id=$1',[user.id])).rows[0].status,'active');
 assert.ok(await identity.login(user.email,spaced));assert.equal(await identity.login(user.email,spaced.trim()),null);
 const other=await identity.login(user.email,spaced);assert.ok(other);const next=synthetic();
 assert.equal(await code(identity.changePassword(done.token,'errada-errada',next)),'INVALID_CREDENTIALS');
 const again=await identity.changePassword(done.token,spaced,next);
 assert.equal(await identity.identitySession(done.token),null);assert.equal(await identity.identitySession(other.token),null,'troca revoga todas as sessões');
 assert.ok(await identity.identitySession(again.token));assert.ok(await identity.login(user.email,next));
 assert.equal((await db.query("select count(*)::int n from auth_session where user_id=$1 and revoked_at is null and token_hash<>$2 and expires_at>now()",[user.id,tokenDigest(again.token)])).rows[0].n,1,'apenas a login e a nova ficam vivas');
}));

test('duas trocas concorrentes com a mesma sessão: só uma vence',async()=>withDb(async({db})=>{
 const pw=synthetic();const user=await addUser(db,{password:pw});const s=await identity.login(user.email,pw);assert.ok(s);
 const [a,b]=[synthetic(),synthetic()];
 const results=await Promise.all([code(identity.changePassword(s.token,pw,a)),code(identity.changePassword(s.token,pw,b))]);
 assert.equal(results.filter(r=>r===null).length,1);assert.equal(results.filter(r=>r==='AUTH_REQUIRED'||r==='INVALID_CREDENTIALS').length,1);
 const winners=[await identity.login(user.email,a),await identity.login(user.email,b)].filter(Boolean);assert.equal(winners.length,1);
}));

test('login, consumo do temporário e troca cancelam jobs obsoletos e avançam geração (R4)',async()=>withDb(async({db})=>{
 const user=await addUser(db,{status:'pending_activation'});const other=await addUser(db);
 const job=async(uid:string,kind:string,status:string,gen:number)=>{const id=randomUUID();await db.query("insert into email_job(id,user_id,kind,generation,status,dedupe_key) values($1,$2,$3,$4,$5,$1::text)",[id,uid,kind,gen,status]);return id;};
 const temp=await issueTemporary(db,user.id);
 const gen0=(await db.query('select credential_generation g from app_user where id=$1',[user.id])).rows[0].g;
 const j1=await job(user.id,'temporary_password','queued',1),j2=await job(user.id,'registration','unconfirmed',1),j3=await job(user.id,'password_reset','sending',1),j4=await job(user.id,'reservation','queued',1),j5=await job(user.id,'temporary_password','accepted',1),j6=await job(other.id,'temporary_password','queued',1);
 const lim=await identity.login(user.email,temp);assert.ok(lim);
 const st=async()=>Object.fromEntries((await db.query('select id,status from email_job')).rows.map(r=>[r.id,r.status]));
 let s=await st();
 assert.deepEqual([s[j1],s[j2],s[j3],s[j4],s[j5],s[j6]],['cancelled','cancelled','sending','queued','accepted','queued'],'temporário consumido cancela só jobs de temporário/cadastro pendentes');
 const gen1=(await db.query('select credential_generation g from app_user where id=$1',[user.id])).rows[0].g;assert.ok(BigInt(gen1)>BigInt(gen0),'consumo avança geração');
 const j7=await job(user.id,'password_reset','queued',2);await identity.changePassword(lim.token,temp,synthetic());s=await st();
 assert.equal(s[j3],'cancelled');assert.equal(s[j7],'cancelled');assert.equal(s[j4],'queued');
 const gen2=(await db.query('select credential_generation g from app_user where id=$1',[user.id])).rows[0].g;assert.ok(BigInt(gen2)>BigInt(gen1));
}));

test('reset: uso único, 30min, revoga sessões/temporários/tokens e cancela jobs',async()=>withDb(async({db})=>{
 const pw=synthetic();const user=await addUser(db,{password:pw});const s1=await identity.login(user.email,pw);assert.ok(s1);
 const t1=await issueReset(db,user.id),t2=await issueReset(db,user.id);
 assert.equal(await code(identity.confirmPasswordReset(t1,synthetic())),'INVALID_RESET','novo token invalida o anterior do mesmo propósito');
 const jid=randomUUID();await db.query("insert into email_job(id,user_id,kind,generation,status,dedupe_key) values($1,$2,'password_reset',9,'queued',$1::text)",[jid,user.id]);
 assert.equal(await code(identity.confirmPasswordReset(t2,'curta')),'INVALID_INPUT');
 assert.equal((await db.query('select used_at is null u from password_reset_token where token_hash=$1',[tokenDigest(t2)])).rows[0].u,true,'senha inválida não consome');
 assert.equal(await code(identity.confirmPasswordReset('invalido',synthetic())),'INVALID_RESET');
 const fresh=synthetic();const conc=await Promise.all([code(identity.confirmPasswordReset(t2,fresh)),code(identity.confirmPasswordReset(t2,synthetic()))]);
 assert.deepEqual(conc.slice().sort(),[null,'INVALID_RESET']);
 assert.equal(await identity.identitySession(s1.token),null);assert.equal(await identity.login(user.email,pw),null);assert.ok(await identity.login(user.email,fresh));
 assert.equal((await db.query('select status from email_job where id=$1',[jid])).rows[0].status,'cancelled');
 assert.equal(await code(identity.confirmPasswordReset(t2,synthetic())),'INVALID_RESET','usado');
 const tmpUser=await addUser(db,{password:pw});const temp=await issueTemporary(db,tmpUser.id);const t3=await issueReset(db,tmpUser.id);await identity.confirmPasswordReset(t3,synthetic());
 assert.equal(await identity.login(tmpUser.email,temp),null,'reset revoga temporário');
 const exp=await issueReset(db,tmpUser.id,'-1 second');assert.equal(await code(identity.confirmPasswordReset(exp,synthetic())),'INVALID_RESET');
 const dis=await addUser(db,{password:pw,status:'disabled'});assert.equal(await code(identity.confirmPasswordReset(await issueReset(db,dis.id),synthetic())),'INVALID_RESET');
}));

test('forgot/emissão não revoga senha ou sessão; reemissão de temporário limpa consumo e invalida sessão limitada',async()=>withDb(async({db})=>{
 const pw=synthetic();const user=await addUser(db,{password:pw});const s=await identity.login(user.email,pw);assert.ok(s);
 await issueReset(db,user.id);assert.ok(await identity.identitySession(s.token));assert.ok(await identity.login(user.email,pw));
 const t1=await issueTemporary(db,user.id);const lim=await identity.login(user.email,t1);assert.ok(lim);
 const t2=await issueTemporary(db,user.id);assert.equal(await identity.identitySession(lim.token),null);assert.equal(await identity.login(user.email,t1),null);
 assert.equal((await db.query('select temporary_used_at is null u from app_user where id=$1',[user.id])).rows[0].u,true);assert.ok(await identity.login(user.email,t2));
}));

test('fronteira de privilégios: runtime só executa funções fechadas; mailer só emite',async()=>withDb(async({db})=>{
 const user=await addUser(db,{password:synthetic()});
 const as=async(role:string,sql:string,params:unknown[]=[])=>{const c=await db.connect();try{await c.query(`set role ${role}`);await c.query(sql,params);return true}catch{return false}finally{await c.query('reset role').catch(()=>undefined);c.release()}};
 for(const sql of ['select password_hash from app_user','select * from app_user',"insert into user_role(user_id,role) values(gen_random_uuid(),'admin')","update app_user set password_hash='x'","update app_user set status='active'",'delete from user_role','select * from auth_session','insert into auth_session(id,user_id,token_hash,scope,session_version,expires_at) values(gen_random_uuid(),gen_random_uuid(),\'x\',\'full\',0,now())','select * from password_reset_token','select * from migration_identity_link'])
  assert.equal(await as('techwoman_runtime',sql),false,'runtime: '+sql);
 assert.equal(await as('techwoman_runtime','select * from internal.identity_login_begin($1)',[user.email]),true);
 assert.equal(await as('techwoman_runtime','select * from internal.identity_session_get($1)',['0'.repeat(64)]),true);
 assert.equal(await as('techwoman_runtime','select internal.issue_temporary_credential($1::uuid,$2)',[user.id,'x']),false);
 assert.equal(await as('techwoman_runtime','select internal.issue_reset_token($1::uuid,$2)',[user.id,'x']),false);
 assert.equal(await as('techwoman_mailer','select internal.issue_reset_token($1::uuid,$2)',[user.id,tokenDigest('synthetic')]),true);
 assert.equal(await as('techwoman_mailer','select * from internal.identity_login_begin($1)',[user.email]),false);
 const defs=(await db.query("select p.proname,p.prosecdef,pg_get_userbyid(p.proowner) owner,p.proconfig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='internal' and p.proname like any(array['identity\\_%','issue\\_%','consume\\_%'])")).rows;
 assert.ok(defs.length>=7);for(const d of defs){assert.equal(d.prosecdef,true,d.proname);assert.ok(/search_path=/.test(String(d.proconfig)),d.proname);}
 assert.equal((await db.query("select has_function_privilege('public','internal.identity_login_begin(text)','execute') p")).rows[0].p,false);
}));

test('nenhum segredo claro persistido: varredura de todas as linhas públicas',async()=>withDb(async({db})=>{
 const pw=synthetic();const user=await addUser(db,{password:pw,status:'pending_activation'});
 const temp=await issueTemporary(db,user.id);const lim=await identity.login(user.email,temp);assert.ok(lim);const fresh=synthetic();const done=await identity.changePassword(lim.token,temp,fresh);
 const reset=await issueReset(db,user.id);const secrets=[temp,lim.token,done.token,reset,fresh,pw];
 const tables=(await db.query("select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'")).rows.map(r=>r.table_name);
 let leaked=false;for(const t of tables){const dump=JSON.stringify((await db.query(`select to_jsonb(x) j from ${t} x`)).rows);if(secrets.some(s=>dump.includes(s)))leaked=true;}
 assert.equal(leaked,false);
}));
