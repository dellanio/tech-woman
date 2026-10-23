import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import {hashPassword,tokenDigest} from '../../src/lib/db';
import * as identity from '../../src/lib/identity';
import * as contracts from '../../src/lib/contracts';
import * as accounts from '../../src/lib/accounts';
import {runPrivilegedAccount} from '../../scripts/privileged-account';
import {withDb,addUser,sessionFor,participantRow,mentorRow,linkFixture,activeEnrollment,synthetic} from './identity-harness.test';

const run=promisify(execFile);
const profile={goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true};
const mentorProfile={displayName:'Mentora Fictícia',trajectory:'Trajetória de teste',specialties:['produto'],availability:'Quartas',legacyCapacity:3,consent:true};
const asRole=async(db:Pool,role:string,sql:string,params:unknown[]=[])=>{const c=await db.connect();try{await c.query(`set role ${role}`);return (await c.query(sql,params)).rows}catch{return null}finally{await c.query('reset role').catch(()=>undefined);c.release()}};
const snap=async(db:Pool)=>JSON.stringify((await db.query(`select (select coalesce(jsonb_agg(to_jsonb(u) order by id),'[]') from app_user u) users,(select coalesce(jsonb_agg(to_jsonb(r) order by user_id,role),'[]') from user_role r) roles,(select coalesce(jsonb_agg(to_jsonb(j) order by id),'[]') from email_job j) jobs,(select coalesce(jsonb_agg(to_jsonb(s) order by id),'[]') from auth_session s) sessions,(select count(*)::int from audit_event) audits,(select count(*)::int from api_idempotency) idem`)).rows[0]);
const adminActor=async(db:Pool,roles:string[]=['admin'])=>{const u=await addUser(db,{password:synthetic(),roles});return {...u,token:await sessionFor(db,u.id)};};

test('predicado de proteção: admin/team, multi-perfil, candidato NULL, vínculo privilegiado e pendências; ambíguo não é privilegiado',async()=>withDb(async({db})=>{
 const {link,issue}=await linkFixture(db);
 const plain=await addUser(db,{email:'plain@example.invalid'});await participantRow(db,1,'plain@example.invalid',plain.id);
 const admin=await addUser(db,{email:'Dona@Example.invalid',roles:['admin','mentor','participant']});await participantRow(db,10,'dona@example.invalid',admin.id);await mentorRow(db,20,'dona@example.invalid',admin.id);
 const team=await addUser(db,{email:'team@example.invalid',roles:['team']});
 await participantRow(db,30,' DONA@example.invalid');
 const pc=await addUser(db,{email:'pc@example.invalid'});await participantRow(db,31,'pc@example.invalid');await link('participant','31',null,'privileged_candidate');
 const conf=await addUser(db,{email:'conf@example.invalid'});await link('admin_user','Conf@Example.invalid',null,'credential_conflict');
 const iss=await addUser(db,{email:'iss@example.invalid'});await participantRow(db,32,'iss@example.invalid');await issue('participant','32','PRIVILEGED_DOMAIN_UNRESOLVED');
 const res=await addUser(db,{email:'res@example.invalid'});await participantRow(db,33,'res@example.invalid');await issue('participant','33','PRIVILEGED_DOMAIN_UNRESOLVED',true);
 const amb=await addUser(db,{email:'amb@example.invalid'});await participantRow(db,34,'amb@example.invalid');await participantRow(db,35,'AMB@example.invalid');await link('participant','34',null,'ambiguous_domain');await link('participant','35',null,'ambiguous_domain');
 const user=async(id:string)=>(await db.query('select internal.user_protected($1::uuid) p',[id])).rows[0].p;
 const dom=async(t:string,id:number)=>(await db.query('select internal.domain_protected($1,$2::bigint) p',[t,id])).rows[0].p;
 assert.deepEqual(await Promise.all([admin,team,pc,conf,iss,plain,res,amb].map(u=>user(u.id))),[true,true,true,true,true,false,false,false]);
 assert.equal(await user(randomUUID()),false);
 assert.deepEqual(await Promise.all([['participant',10],['mentor',20],['participant',30],['participant',31],['participant',32],['participant',1],['participant',33],['participant',34],['participant',35],['participant',999]].map(([t,i])=>dom(String(t),Number(i)))),[true,true,true,true,true,false,false,false,false,false]);
 assert.equal(await dom('unknown',1),true,'tabela desconhecida é conservadoramente protegida');
 const fns=(await db.query("select p.proname,p.prosecdef,p.proconfig::text cfg,has_function_privilege('public',p.oid,'execute') pub,has_function_privilege('techwoman_runtime',p.oid,'execute') rt,has_function_privilege('techwoman_mailer',p.oid,'execute') ml,pg_get_function_result(p.oid) res from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='internal' and p.proname in ('user_protected','domain_protected','privileged_email_keys')")).rows;
 assert.equal(fns.length,3);
 for(const f of fns){assert.equal(f.prosecdef,true,f.proname);assert.match(f.cfg,/search_path=pg_catalog, pg_temp/);assert.equal(f.pub,false);assert.equal(f.ml,false);assert.equal(f.rt,false,`${f.proname}: helper nu sem EXECUTE do runtime (WP-003 M4; operações SQL o usam como definer)`);}
 assert.equal(fns.filter(f=>f.proname!=='privileged_email_keys').every(f=>f.res==='boolean'),true,'só boolean');
 assert.equal(await asRole(db,'techwoman_runtime','select internal.user_protected($1::uuid) p',[admin.id]),null);
 assert.equal(await asRole(db,'techwoman_runtime',"select internal.domain_protected('participant',30) p"),null);
 assert.equal(await asRole(db,'techwoman_runtime','select * from migration_identity_link'),null);
 assert.equal(await asRole(db,'techwoman_runtime','select * from internal.privileged_email_keys()'),null);
}));

test('leitura: lista e GET só de contas comuns; protegido, NULL privilegiado e inexistente são indistinguíveis; team lê, não escreve',async()=>withDb(async({db})=>{
 const {link}=await linkFixture(db);
 const actor=await adminActor(db);const team=await adminActor(db,['team']);
 const a=await addUser(db,{email:'a@example.invalid'}),b=await addUser(db,{email:'b@example.invalid',roles:['mentor']}),c=await addUser(db,{email:'c@example.invalid',status:'disabled',roles:[]});
 const multi=await addUser(db,{email:'multi@example.invalid',roles:['admin','mentor','participant']});
 const pc=await addUser(db,{email:'pc@example.invalid'});await participantRow(db,31,'pc@example.invalid');await link('participant','31',null,'privileged_candidate');
 const ids=[a.id,b.id,c.id].sort();
 const full=await accounts.listAccounts(actor.token,{limit:100});
 assert.equal(full.outcome,'ok');assert.deepEqual(full.users?.map(u=>u.id),ids);assert.equal(full.nextCursor,null);
 const sample=full.users?.find(u=>u.id===b.id);assert.deepEqual(sample,{id:b.id,email:'b@example.invalid',status:'active',roles:['mentor'],version:sample?.version});assert.match(String(sample?.version),/^[1-9][0-9]*$/);
 const p1=await accounts.listAccounts(actor.token,{limit:2});assert.deepEqual(p1.users?.map(u=>u.id),ids.slice(0,2));assert.equal(typeof p1.nextCursor,'string');
 const p2=await accounts.listAccounts(actor.token,{limit:2,cursor:p1.nextCursor});assert.deepEqual(p2.users?.map(u=>u.id),ids.slice(2));assert.equal(p2.nextCursor,null);
 for(const bad of [{cursor:'nao-eh-cursor'},{cursor:Buffer.from('{"id":"x"}').toString('base64url')},{limit:0},{limit:101},{limit:1.5}])await assert.rejects(()=>accounts.listAccounts(actor.token,bad),(e:unknown)=>e instanceof contracts.ContractError);
 assert.equal((await accounts.listAccounts(actor.token,{})).users?.length,3,'limite padrão 20');
 const hidden=[await accounts.getAccount(actor.token,multi.id),await accounts.getAccount(actor.token,pc.id),await accounts.getAccount(actor.token,team.id),await accounts.getAccount(actor.token,actor.id),await accounts.getAccount(actor.token,randomUUID())];
 for(const h of hidden)assert.deepEqual(h,{outcome:'not_found'});
 assert.equal((await accounts.getAccount(actor.token,a.id)).user?.email,'a@example.invalid');
 assert.equal((await accounts.getAccount(team.token,a.id)).outcome,'ok');assert.equal((await accounts.listAccounts(team.token,{})).outcome,'ok');
 assert.deepEqual(await accounts.getAccount(actor.token,'não-é-uuid'),{outcome:'not_found'});
 const before=await snap(db);
 assert.equal((await accounts.updateAccount(team.token,a.id,'1',{status:'disabled'})).outcome,'forbidden');
 assert.equal((await accounts.disableAccount(team.token,a.id,'1')).outcome,'forbidden');
 assert.equal((await accounts.resendTemporary(team.token,a.id,randomUUID())).outcome,'forbidden');
 assert.equal((await accounts.createAccount(team.token,randomUUID(),{email:'n@example.invalid',roles:['participant'],participant:profile})).outcome,'forbidden');
 assert.equal(await snap(db),before,'team: zero mutação');
 const plainUser=await addUser(db,{email:'pl@example.invalid'});const pt=await sessionFor(db,plainUser.id);const limited=await sessionFor(db,a.id,'password_change');
 assert.equal((await accounts.listAccounts(pt,{})).outcome,'forbidden');assert.equal((await accounts.listAccounts(limited,{})).outcome,'auth_required');assert.equal((await accounts.listAccounts('x'.repeat(43),{})).outcome,'auth_required');
 await db.query("update auth_session set revoked_at=now() where token_hash=$1",[tokenDigest(actor.token)]);assert.equal((await accounts.listAccounts(actor.token,{})).outcome,'auth_required');
 await db.query("update app_user set status='disabled' where id=$1",[team.id]);assert.equal((await accounts.getAccount(team.token,a.id)).outcome,'auth_required');
}));

test('PATCH/DELETE exigem versão atual (If-Match), protegem admin sob lock e auditam apenas nomes de campos',async()=>withDb(async({db})=>{
 const actor=await adminActor(db);const u=await addUser(db,{email:'alvo@example.invalid',password:synthetic()});const admin2=await addUser(db,{email:'adm2@example.invalid',roles:['admin','participant']});
 const v0=(await accounts.getAccount(actor.token,u.id)).user?.version;assert.ok(v0);
 const before=await snap(db);
 assert.equal((await accounts.updateAccount(actor.token,u.id,String(Number(v0)+5),{status:'disabled'})).outcome,'version_mismatch');
 assert.equal((await accounts.disableAccount(actor.token,u.id,'0')).outcome,'version_mismatch');
 assert.equal((await accounts.updateAccount(actor.token,admin2.id,'1',{status:'disabled'})).outcome,'not_found');
 assert.equal((await accounts.updateAccount(actor.token,actor.id,'1',{status:'disabled'})).outcome,'not_found');
 assert.equal((await accounts.updateAccount(actor.token,randomUUID(),'1',{status:'disabled'})).outcome,'not_found');
 assert.equal(await snap(db),before,'mismatch/protegido/inexistente: zero mutação');
 for(const bad of [{},{role:'admin'},{email:'x@example.invalid',id:'1'},{roles:['admin']},{roles:['team']},{roles:['mentor','mentor']},{status:'pending_activation'},{password:'x'},[],null,{email:'sem-arroba'}])
  await assert.rejects(()=>accounts.updateAccount(actor.token,u.id,String(v0),bad),(e:unknown)=>e instanceof contracts.ContractError,JSON.stringify(bad));
 const done=await accounts.updateAccount(actor.token,u.id,String(v0),{status:'disabled'});
 assert.equal(done.outcome,'ok');assert.equal(done.user?.status,'disabled');assert.ok(Number(done.user?.version)>Number(v0));
 assert.equal((await accounts.updateAccount(actor.token,u.id,String(v0),{status:'active'})).outcome,'version_mismatch','versão antiga não vale depois da escrita');
 const audits=(await db.query('select actor_user_id,action,entity_type,entity_id,changed_fields,result from audit_event')).rows;
 assert.deepEqual(audits,[{actor_user_id:actor.id,action:'user.update',entity_type:'user',entity_id:u.id,changed_fields:['status'],result:'ok'}]);
 assert.equal(JSON.stringify(audits).includes('alvo@example.invalid'),false);
 const re=await accounts.updateAccount(actor.token,u.id,String(done.user?.version),{status:'active'});assert.equal(re.user?.status,'active','reativação preserva senha definitiva');
 const fresh=await addUser(db,{email:'semsenha@example.invalid',status:'disabled'});
 assert.equal((await accounts.updateAccount(actor.token,fresh.id,'1',{status:'active'})).user?.status,'pending_activation','sem senha definitiva volta a pendente');
}));

test('troca de e-mail: destino indisponível é genérico; revoga sessões/tokens, cancela jobs, volta a pendente e enfileira ativação para o novo destino',async()=>withDb(async({db})=>{
 const {link}=await linkFixture(db);
 const actor=await adminActor(db);const pw=synthetic();const u=await addUser(db,{email:'Antigo@Example.invalid',password:pw});await participantRow(db,1,'antigo@example.invalid',u.id);
 const other=await addUser(db,{email:'ocupado@example.invalid'});await participantRow(db,40,'legado.livre@example.invalid');
 await link('admin_user','Legado.Admin@Example.invalid',null,'credential_conflict');
 const s1=await identity.login(u.email,pw);assert.ok(s1);
 await db.query("insert into email_job(id,user_id,kind,generation,status,dedupe_key) values(gen_random_uuid(),$1,'registration',0,'queued','k1'),(gen_random_uuid(),$1,'temporary_password',0,'unconfirmed','k2'),(gen_random_uuid(),$1,'password_reset',0,'queued','k3')",[u.id]);
 await db.query("insert into password_reset_token(id,user_id,token_hash,generation,expires_at) values(gen_random_uuid(),$1,$2,0,now()+interval '10 minutes')",[u.id,tokenDigest('r')]);
 const hashBefore=(await db.query('select password_hash h,credential_generation::int g from app_user where id=$1',[u.id])).rows[0];
 const v=String((await accounts.getAccount(actor.token,u.id)).user?.version);
 const snapBefore=await snap(db);
 const results=[];for(const email of ['OCUPADO@example.invalid',' ocupado@example.invalid ','legado.livre@example.invalid','legado.admin@example.invalid'])results.push(await accounts.updateAccount(actor.token,u.id,v,{email}));
 assert.deepEqual(results,Array(4).fill({outcome:'email_unavailable'}),'sem revelar o tipo do destino existente');
 assert.equal(await snap(db),snapBefore);
 const ok=await accounts.updateAccount(actor.token,u.id,v,{email:'  Novo.Destino@Example.invalid '});
 assert.equal(ok.outcome,'ok');assert.deepEqual([ok.user?.email,ok.user?.status],['Novo.Destino@Example.invalid','pending_activation']);
 const row=(await db.query('select email_key,password_hash=$2 same,credential_generation::int g,temporary_password_hash is null t from app_user where id=$1',[u.id,hashBefore.h])).rows[0];
 assert.deepEqual([row.email_key,row.same,row.g>hashBefore.g,row.t],['novo.destino@example.invalid',true,true,true]);
 assert.equal(await identity.identitySession(s1.token),null,'sessões revogadas');
 assert.equal(await identity.login('novo.destino@example.invalid',pw),null,'pendente: senha antiga não entra até a ativação');
 assert.equal((await db.query('select count(*)::int n from password_reset_token where revoked_at is null')).rows[0].n,0);
 const jobs=(await db.query('select kind,status from email_job where user_id=$1 order by created_at,id',[u.id])).rows;
 assert.deepEqual(jobs.filter(j=>j.status!=='cancelled'),[{kind:'temporary_password',status:'queued'}]);assert.equal(jobs.filter(j=>j.status==='cancelled').length,3);
 assert.equal((await db.query('select email from participant where id=1')).rows[0].email,'antigo@example.invalid','domínio não é reescrito por esta ação');
 assert.deepEqual((await db.query("select changed_fields from audit_event where action='user.update'")).rows,[{changed_fields:['email']}]);
 const same=await accounts.updateAccount(actor.token,u.id,String(ok.user?.version),{email:'Novo.Destino@Example.invalid'});assert.equal(same.outcome,'ok');assert.equal(same.user?.version,ok.user?.version,'mesmo e-mail: sem escrita');
 assert.equal((await db.query("select count(*)::int n from email_job where status='queued'")).rows[0].n,1);
 const dis=await addUser(db,{email:'dis@example.invalid',status:'disabled'});
 assert.equal((await accounts.updateAccount(actor.token,dis.id,'1',{email:'dis.novo@example.invalid'})).user?.status,'disabled');
 assert.equal((await db.query('select count(*)::int n from email_job where user_id=$1',[dis.id])).rows[0].n,0,'desativado não recebe job');
 void other;
}));

test('perfis: só participant/mentor com domínio ligado; remover com reserva ativa → conflito; sem criar domínio por toggle',async()=>withDb(async({db})=>{
 const actor=await adminActor(db);const u=await addUser(db,{email:'p@example.invalid',roles:['participant']});await participantRow(db,1,'p@example.invalid',u.id);
 const v=async()=>String((await accounts.getAccount(actor.token,u.id)).user?.version);
 const before=await snap(db);
 assert.equal((await accounts.updateAccount(actor.token,u.id,await v(),{roles:['participant','mentor']})).outcome,'invalid','mentor sem domínio ligado');
 assert.equal(await snap(db),before);
 await mentorRow(db,20,'p@example.invalid',u.id);
 const added=await accounts.updateAccount(actor.token,u.id,await v(),{roles:['mentor','participant']});assert.deepEqual([added.outcome,added.user?.roles],['ok',['mentor','participant']]);
 assert.deepEqual((await db.query('select count(*)::int p,(select count(*)::int from mentor) m from participant')).rows[0],{p:1,m:1},'nenhum domínio criado');
 await activeEnrollment(db,1,20);
 const withBooking=await snap(db);
 assert.equal((await accounts.updateAccount(actor.token,u.id,await v(),{roles:['mentor']})).outcome,'conflict_active','remover participant com reserva ativa');
 assert.equal(await snap(db),withBooking);
 assert.equal((await accounts.disableAccount(actor.token,u.id,await v())).outcome,'conflict_active','desativar exige cancelar antes');
 await db.query("update enrollment set status='cancelled',cancelled_at=now()");
 const removed=await accounts.updateAccount(actor.token,u.id,await v(),{roles:['mentor']});assert.deepEqual([removed.outcome,removed.user?.roles],['ok',['mentor']]);
 assert.equal((await db.query('select user_id from participant where id=1')).rows[0].user_id,u.id,'vínculo e histórico preservados');
 assert.equal((await accounts.updateAccount(actor.token,u.id,await v(),{roles:[]})).user?.roles.length,0);
}));

test('DELETE = desativar: revoga sessões, cancela jobs e credenciais temporárias; histórico preservado',async()=>withDb(async({db})=>{
 const actor=await adminActor(db);const pw=synthetic();const u=await addUser(db,{email:'d@example.invalid',password:pw});await participantRow(db,1,'d@example.invalid',u.id);
 const s=await identity.login(u.email,pw);assert.ok(s);
 await db.query("insert into email_job(id,user_id,kind,generation,status,dedupe_key) values(gen_random_uuid(),$1,'registration',0,'queued','k1'),(gen_random_uuid(),$1,'reservation',0,'queued','k2')",[u.id]);
 await db.query("update app_user set temporary_password_hash='x',temporary_expires_at=now()+interval '1 hour',must_change_password=true where id=$1",[u.id]);
 const v=String((await accounts.getAccount(actor.token,u.id)).user?.version);
 const out=await accounts.disableAccount(actor.token,u.id,v);assert.deepEqual([out.outcome,out.user?.status],['ok','disabled']);
 assert.equal(await identity.identitySession(s.token),null);assert.equal(await identity.login(u.email,pw),null);
 assert.equal((await db.query("select count(*)::int n from email_job where status<>'cancelled'")).rows[0].n,0);
 assert.deepEqual((await db.query('select temporary_password_hash is null t,temporary_expires_at is null e from app_user where id=$1',[u.id])).rows[0],{t:true,e:true});
 assert.equal((await db.query('select count(*)::int n from participant')).rows[0].n,1);
 const again=await accounts.disableAccount(actor.token,u.id,String(out.user?.version));assert.deepEqual([again.outcome,again.user?.status,again.user?.version],['ok','disabled',out.user?.version]);
 assert.deepEqual((await db.query("select action,changed_fields from audit_event order by id")).rows,[{action:'user.disable',changed_fields:['status']}]);
}));

test('reenvio administrativo: idempotente por chave (mesmo job), só não-admin ativo/pendente, sem segredo em api_idempotency',async()=>withDb(async({db})=>{
 const actor=await adminActor(db);const u=await addUser(db,{email:'r@example.invalid',password:synthetic()});const admin2=await addUser(db,{email:'adm2@example.invalid',roles:['admin']});const dis=await addUser(db,{email:'dis@example.invalid',status:'disabled'});
 const k1=randomUUID(),k2=randomUUID();
 const first=await accounts.resendTemporary(actor.token,u.id,k1);assert.equal(first.outcome,'ok');assert.equal(first.job?.status,'queued');assert.match(String(first.job?.jobId),/^[0-9a-f-]{36}$/);
 const again=await accounts.resendTemporary(actor.token,u.id,k1.toUpperCase());assert.deepEqual(again,first);
 assert.equal((await db.query("select count(*)::int n from email_job where kind='temporary_password'")).rows[0].n,1);
 const second=await accounts.resendTemporary(actor.token,u.id,k2);assert.notEqual(second.job?.jobId,first.job?.jobId);
 const idem=(await db.query('select actor_key,method,path,key_hash,request_hash,resource_id,status_code,expires_at>now()+interval \'23 hours\' ttl from api_idempotency order by created_at')).rows;
 assert.equal(idem.length,2);assert.deepEqual([idem[0].method,idem[0].path,idem[0].resource_id,idem[0].status_code,idem[0].ttl],['POST',`/api/v1/admin/users/${u.id}/temporary-password`,first.job?.jobId,202,true]);
 assert.equal(JSON.stringify(idem).includes(k1),false,'chave só em hash');
 const before=await snap(db);
 for(const target of [admin2.id,actor.id,dis.id,randomUUID()])assert.deepEqual(await accounts.resendTemporary(actor.token,target,randomUUID()),{outcome:'not_found'});
 await assert.rejects(()=>accounts.resendTemporary(actor.token,u.id,'nao-uuid'),(e:unknown)=>e instanceof identity.IdentityError&&e.code==='INVALID_INPUT');
 assert.equal(await snap(db),before);
 await db.query("insert into user_role(user_id,role) values($1,'team')",[u.id]);
 assert.deepEqual(await accounts.resendTemporary(actor.token,u.id,k1),{outcome:'not_found'},'replay depois de virar privilegiado: 404, sem job novo');
}));

test('criação: roles = domínios fornecidos, e-mail indisponível genérico, idempotência por chave com conflito de corpo',async()=>withDb(async({db})=>{
 const {link}=await linkFixture(db);
 const actor=await adminActor(db);await addUser(db,{email:'existe@example.invalid'});await participantRow(db,40,'legado@example.invalid');await link('admin_user','Priv@Example.invalid',null,'credential_conflict');
 const dto={email:'  Nova@Example.invalid',roles:['participant','mentor'],participant:profile,mentor:mentorProfile};const key=randomUUID();
 const made=await accounts.createAccount(actor.token,key,dto);assert.equal(made.outcome,'ok');assert.deepEqual([made.user?.email,made.user?.status,made.user?.roles],['Nova@Example.invalid','pending_activation',['mentor','participant']]);
 const row=(await db.query('select (select user_id from participant where email=$1) p,(select user_id from mentor where email=$1) m,(select count(*)::int from email_job where user_id=$2 and kind=\'registration\' and status=\'queued\') j,(select password_hash is null and temporary_password_hash is null from app_user where id=$2) nopw',['Nova@Example.invalid',made.user?.id])).rows[0];
 assert.deepEqual(row,{p:made.user?.id,m:made.user?.id,j:1,nopw:true});
 const replay=await accounts.createAccount(actor.token,key,dto);assert.deepEqual([replay.outcome,replay.user?.id],['ok',made.user?.id]);
 assert.equal((await db.query('select (select count(*)::int from app_user where email_key=\'nova@example.invalid\') u,(select count(*)::int from email_job where kind=\'registration\') j')).rows[0].u,1);
 assert.deepEqual(await accounts.createAccount(actor.token,key,{...dto,email:'outra@example.invalid'}),{outcome:'idempotency_conflict'});
 const before=await snap(db);
 const taken=[];for(const email of ['EXISTE@example.invalid','legado@example.invalid','priv@example.invalid','nova@example.invalid'])taken.push(await accounts.createAccount(actor.token,randomUUID(),{email,roles:['participant'],participant:profile}));
 assert.deepEqual(taken,Array(4).fill({outcome:'email_unavailable'}));assert.equal(await snap(db),before,'falha não deixa linha de idempotência');
 const retryKey=randomUUID();assert.equal((await accounts.createAccount(actor.token,retryKey,{email:'existe@example.invalid',roles:['participant'],participant:profile})).outcome,'email_unavailable');
 assert.equal((await accounts.createAccount(actor.token,retryKey,{email:'livre@example.invalid',roles:['participant'],participant:profile})).outcome,'ok','mesma chave pode ser reutilizada após falha sem efeito');
 for(const bad of [{email:'a@example.invalid',roles:['mentor'],participant:profile},{email:'a@example.invalid',roles:['participant']},{email:'a@example.invalid',roles:[]},{email:'a@example.invalid',roles:['admin'],participant:profile},{email:'a@example.invalid',roles:['participant'],participant:{...profile,email:'x@example.invalid'}},{email:'a@example.invalid',roles:['participant'],participant:profile,userId:'1'},{email:'a@example.invalid',roles:['participant','participant'],participant:profile},{email:'a@example.invalid',roles:['participant'],participant:{...profile,roles:['admin']}}])
  await assert.rejects(()=>accounts.createAccount(actor.token,randomUUID(),bad),(e:unknown)=>e instanceof contracts.ContractError,JSON.stringify(Object.keys(bad)));
 assert.equal((await db.query("select count(*)::int n from user_role where role in ('admin','team')")).rows[0].n,1,'só o ator; criação nunca concede admin/team');
 await assert.rejects(()=>accounts.createAccount(actor.token,'nao-uuid',dto),(e:unknown)=>e instanceof identity.IdentityError&&e.code==='INVALID_INPUT');
}));

test('script offline de elevação: só por UUID, mesmo lock, recusa desativado/pendente/colisão/último admin, imprime apenas código',async()=>withDb(async({db,url})=>{
 const {link}=await linkFixture(db);
 const u=await addUser(db,{email:'elev@example.invalid',password:synthetic()});await participantRow(db,1,'elev@example.invalid',u.id);
 const s=await sessionFor(db,u.id);const env={MIGRATION_DATABASE_URL:url};const cmd=(c:string,id:string,extra:string[]=['--confirm'])=>runPrivilegedAccount([c,'--user-id',id,...extra],env);
 const before=(await db.query('select email,email_key,status,password_hash from app_user where id=$1',[u.id])).rows[0];
 assert.deepEqual(await runPrivilegedAccount(['grant-admin','--user-id',u.id,'--confirm'],{}),{code:'MIGRATION_DATABASE_URL_REQUIRED'});
 assert.deepEqual(await cmd('grant-admin',u.id,[]),{code:'CONFIRM_REQUIRED'});
 assert.deepEqual(await cmd('grant-admin',u.email),{code:'INVALID_USER_ID'},'sem busca por e-mail');
 assert.deepEqual(await cmd('make-admin',u.id),{code:'USAGE'});
 assert.deepEqual(await runPrivilegedAccount(['grant-admin','--user-id',u.id,'--confirm','--email','x@example.invalid'],env),{code:'USAGE'});
 assert.deepEqual(await cmd('grant-admin',randomUUID()),{code:'USER_NOT_FOUND'});
 assert.equal((await db.query("select count(*)::int n from user_role where role='admin'")).rows[0].n,0);
 assert.deepEqual(await cmd('grant-admin',u.id),{code:'ok'});assert.deepEqual(await cmd('grant-admin',u.id),{code:'ok'},'idempotente');
 assert.deepEqual((await db.query('select role from user_role where user_id=$1 order by role',[u.id])).rows.map(r=>r.role),['admin','participant']);
 assert.deepEqual((await db.query('select email,email_key,status,password_hash from app_user where id=$1',[u.id])).rows[0],before,'nunca renomeia nem altera credencial');
 assert.equal(await identity.identitySession(s),null,'elevação revoga sessões anteriores');
 assert.equal((await db.query('select user_id from participant where id=1')).rows[0].user_id,u.id);
 assert.deepEqual((await db.query("select actor_user_id,action,entity_type,entity_id,changed_fields,result from audit_event where action like 'privileged.%'")).rows,[{actor_user_id:null,action:'privileged.grant_admin',entity_type:'user',entity_id:u.id,changed_fields:['role'],result:'ok'}],'só mudança real é auditada; repetição idempotente não');
 assert.deepEqual(await cmd('grant-team',u.id),{code:'ok'});assert.deepEqual(await cmd('revoke-team',u.id),{code:'ok'});
 assert.deepEqual(await cmd('revoke-admin',u.id),{code:'LAST_ADMIN'},'não remove o último admin');
 const second=await addUser(db,{email:'segundo@example.invalid',password:synthetic(),roles:['admin']});
 assert.deepEqual(await cmd('revoke-admin',u.id),{code:'ok'});assert.deepEqual((await db.query('select role from user_role where user_id=$1',[u.id])).rows.map(r=>r.role),['participant']);
 const dis=await addUser(db,{email:'dis@example.invalid',status:'disabled'}),pend=await addUser(db,{email:'pend@example.invalid',status:'pending_activation'});
 assert.deepEqual([await cmd('grant-admin',dis.id),await cmd('revoke-admin',dis.id),await cmd('grant-team',pend.id)],[{code:'USER_DISABLED'},{code:'USER_DISABLED'},{code:'USER_NOT_ACTIVE'}]);
 const col=await addUser(db,{email:'Colisao@Example.invalid',password:synthetic()});await link('admin_user','colisao@example.invalid',null,'credential_conflict');
 assert.deepEqual(await cmd('grant-admin',col.id),{code:'COLLISION_UNRESOLVED'});assert.deepEqual((await db.query("select count(*)::int n from user_role where user_id=$1 and role in ('admin','team')",[col.id])).rows[0],{n:0});
 void second;
 const cli=await run(process.execPath,['--import','tsx','scripts/privileged-account.ts','grant-team','--user-id',u.id,'--confirm'],{env:{...process.env,MIGRATION_DATABASE_URL:url}});
 assert.equal(cli.stdout,'ok\n');assert.equal(cli.stderr,'');
 const noUrl=await run(process.execPath,['--import','tsx','scripts/privileged-account.ts','grant-team','--user-id',u.id,'--confirm'],{env:{...process.env,MIGRATION_DATABASE_URL:undefined}}).then(()=>null,(e:{code?:number;stdout:string;stderr:string})=>e);
 assert.ok(noUrl);assert.deepEqual([noUrl.code,noUrl.stdout,noUrl.stderr],[1,'','MIGRATION_DATABASE_URL_REQUIRED\n']);
}));

test('corrida elevação × CRUD: elevação segura o lock, CRUD espera e vira 404 sem mutação; CRUD antes da elevação fica consistente',async()=>withDb(async({db,url})=>{
 const actor=await adminActor(db);const u=await addUser(db,{email:'corrida@example.invalid',password:synthetic()});await participantRow(db,1,'corrida@example.invalid',u.id);await mentorRow(db,20,'corrida@example.invalid',u.id);
 const blocked=async(n:number)=>{for(let i=0;i<200;i++){const c=(await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and state='active' and wait_event_type='Lock'")).rows[0].n;if(c>=n)return c;await new Promise(r=>setTimeout(r,25));}throw new Error('operações não bloquearam');};
 const v=String((await accounts.getAccount(actor.token,u.id)).user?.version);const before=await snap(db);
 let pending:Promise<unknown[]>=Promise.resolve([]);
 const elevated=await runPrivilegedAccount(['grant-admin','--user-id',u.id,'--confirm'],{MIGRATION_DATABASE_URL:url},{afterLock:async()=>{
  pending=Promise.all([accounts.updateAccount(actor.token,u.id,v,{email:'novo@example.invalid'}),accounts.disableAccount(actor.token,u.id,v),accounts.resendTemporary(actor.token,u.id,randomUUID()),accounts.updateAccount(actor.token,u.id,v,{roles:['participant']})]);
  await blocked(4);
 }});
 assert.deepEqual(elevated,{code:'ok'});
 const results=await pending;
 assert.deepEqual(results,Array(4).fill({outcome:'not_found'}),'quem esperava o lock enxerga o alvo já protegido');
 const after=JSON.parse(await snap(db)),prior=JSON.parse(before);
 assert.equal(after.audits,prior.audits+1,'só a auditoria da elevação');assert.equal(after.idem,0);assert.equal(after.jobs.length,0);
 assert.deepEqual(after.roles.filter((r:{user_id:string})=>r.user_id===u.id).map((r:{role:string})=>r.role).sort(),['admin','participant']);
 const row=(await db.query('select email,status from app_user where id=$1',[u.id])).rows[0];assert.deepEqual(row,{email:'corrida@example.invalid',status:'active'});
 // inverso: CRUD em andamento segura o lock; a elevação espera e aplica sobre o resultado do CRUD
 const w=await addUser(db,{email:'inverso@example.invalid',password:synthetic()});
 const holder=await db.connect();
 try{
  await holder.query('begin');await holder.query('select id from app_user where id=$1 for update',[w.id]);
  const elev=runPrivilegedAccount(['grant-team','--user-id',w.id,'--confirm'],{MIGRATION_DATABASE_URL:url});
  await blocked(1);
  await holder.query("update app_user set email='inverso.novo@example.invalid' where id=$1",[w.id]);await holder.query('commit');
  assert.deepEqual(await elev,{code:'ok'});
 }finally{holder.release();}
 assert.deepEqual((await db.query('select email,status,array(select role from user_role where user_id=app_user.id order by role) roles from app_user where id=$1',[w.id])).rows[0],{email:'inverso.novo@example.invalid',status:'active',roles:['participant','team']});
}));

test('fronteira: runtime executa só as funções fechadas de contas/limites; helpers e escrita livre negados; mailer sem emissão nua',async()=>withDb(async({db})=>{
 const u=await addUser(db,{password:synthetic()});
 const exec=async(role:string,sig:string)=>(await db.query('select has_function_privilege($1,$2,\'execute\') p',[role,sig])).rows[0].p;
 for(const sig of ['internal.admin_user_list(text,uuid,integer)','internal.admin_user_get(text,uuid)','internal.admin_user_update(text,uuid,bigint,jsonb,uuid)','internal.admin_user_disable(text,uuid,bigint,uuid)','internal.admin_user_resend(text,uuid,uuid)','internal.admin_user_create(text,uuid,text,text,text[],jsonb,jsonb,uuid)'])
  assert.deepEqual([sig,await exec('techwoman_runtime',sig),await exec('techwoman_mailer',sig),await exec('public',sig)],[sig,true,false,false]);
 for(const sig of ['internal.lock_users(uuid,uuid)','internal.admin_actor(text,boolean,uuid)'])assert.deepEqual([sig,await exec('techwoman_runtime',sig)],[sig,false]);
 assert.equal(await exec('techwoman_mailer','internal.issue_temporary_credential(uuid,text)'),false);
 assert.equal(await exec('techwoman_mailer','internal.issue_reset_token(uuid,text)'),false);
 assert.equal(await exec('techwoman_mailer','internal.email_claim(uuid)'),true);
 for(const sql of ['select * from auth_rate_bucket','select * from api_idempotency','insert into audit_event(action,entity_type,entity_id,changed_fields,result,request_id) values(\'a\',\'b\',\'c\',\'[]\',\'ok\',gen_random_uuid())','update app_user set status=\'disabled\'','insert into user_role(user_id,role) values(gen_random_uuid(),\'admin\')'])
  assert.equal(await asRole(db,'techwoman_runtime',sql),null,sql);
 void u;void hashPassword;
}));

test('replay idempotente de criação não devolve conta que virou protegida (admin/team invisíveis)',async()=>withDb(async({db})=>{
 const actor=await adminActor(db);const dto={email:'replay@example.invalid',roles:['participant'],participant:profile};const key=randomUUID();
 const made=await accounts.createAccount(actor.token,key,dto);assert.equal(made.outcome,'ok');
 assert.deepEqual((await accounts.createAccount(actor.token,key,dto)).outcome,'ok','antes da elevação o replay segue devolvendo a conta');
 await db.query("insert into user_role(user_id,role) values($1,'team')",[made.user?.id]);
 assert.deepEqual(await accounts.createAccount(actor.token,key,dto),{outcome:'not_found'},'após elevação o replay é indistinguível de inexistente');
}));

test('runtime e mailer não executam enqueue_admin_temporary (reenvio só por admin_user_resend com ator)',async()=>withDb(async({db})=>{
 for(const role of ['techwoman_runtime','techwoman_mailer','public'])
  assert.deepEqual([role,(await db.query('select has_function_privilege($1,\'internal.enqueue_admin_temporary(uuid,text)\',\'execute\') p',[role])).rows[0].p],[role,false]);
}));
