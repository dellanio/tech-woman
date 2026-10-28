/**
 * Cadastro com crossing × escritas concorrentes (AJUSTE-INSCRICAO, correções pós-revisão 2/3). Duas conexões reais no PG16, barreira por
 * pg_stat_activity (backend bloqueado em lock), sem sleeps de duração arbitrária. O cadastro segue o protocolo R3: contas que decidem a proteção da
 * mentora (dona vinculada e contas com a mesma chave de e-mail), FOR NO KEY UPDATE em ordem de UUID → guard → reconferência do conjunto (40001)
 * → linha da mentora → proteção/compatibilidade. Assim não forma ciclo com a edição admin (guard → mentora) e se serializa com a elevação offline.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {Client,type Pool} from 'pg';
import * as participants from '../../src/app/api/v1/registrations/participants/route';
import * as preview from '../../src/app/api/v1/registrations/participants/preview/route';
import {tokenDigest} from '../../src/lib/db';
import {runPrivilegedAccount} from '../../scripts/privileged-account';
import {withDb,addUser,sessionFor} from './identity-harness.test';
import {call,code,type Reply} from './identity-http-kit.test';
import {DIAGNOSTIC,crossingMentors,fullSnapshot} from './crossing-fixtures';

const REG='/api/v1/registrations/participants';
const strong=()=>`Recife-${randomBytes(12).toString('base64url')}`;
const signup=(addr:string,ref:string)=>{const password=strong();return {email:addr,...DIAGNOSTIC,consent:true,mentor_ref:ref,password,passwordConfirmation:password};};
const send=(body:unknown)=>call(participants.POST,REG,{body,key:randomUUID()});
const refOf=async(name:string)=>((await call(preview.POST,'/api/v1/registrations/participants/preview',{body:DIAGNOSTIC})).json.data as {mentor_ref:string;nome_exibicao:string}[]).find(c=>c.nome_exibicao===name)!.mentor_ref;
const outcome=(r:Reply)=>[r.status,r.status<300?null:code(r),r.json?.error?.fields??[]];
const lockWaiters=async(db:Pool)=>(await db.query("select count(*)::int n from pg_stat_activity where datname=current_database() and state='active' and wait_event_type='Lock'")).rows[0].n as number;
/** Barreira real: n backends bloqueados em lock, ou a requisição terminou sem bloquear (o teste reprova depois pelo resultado/`waited`). */
async function untilBlocked(db:Pool,pending:Promise<unknown>,n:number){
 let done=false;pending.then(()=>{done=true;},()=>{done=true;});
 for(let i=0;i<200&&!done;i++){if(await lockWaiters(db)>=n)return true;await new Promise(r=>setTimeout(r,25));}
 return false;
}
const registered=async(db:Pool,addr:string)=>(await db.query('select x.mentor_id::text m from app_user u join participant p on p.user_id=u.id join match x on x.participant_id=p.id where u.email_key=$1',[addr])).rows.map(r=>String(r.m));

test('item 2: cadastro × edição admin da mesma mentora com o guard já tomado (guard → mentora): sem deadlock, as duas concluem',async()=>withDb(async({db,url})=>{
 const m=await crossingMentors(db);const anaRef=await refOf('Ana Dados');
 const admin=await addUser(db,{roles:['admin']});const digest=tokenDigest(await sessionFor(db,admin.id));
 const version=String((await db.query('select version::text v from mentor where id=$1',[m.ana])).rows[0].v);
 const editor=new Client({connectionString:url});await editor.connect();
 try{
  // T2 = api_admin_domain_update parada entre o guard e a linha da mentora (ordem do protocolo: contas → guard → domínio)
  await editor.query('begin');await editor.query('update internal.agenda_guard set revision=revision+1 where id=1');
  const pending=send(signup('corrida-admin@example.invalid',anaRef));
  const waited=await untilBlocked(db,pending,1);
  let adminError:string|null=null;
  try{await editor.query("select internal.api_admin_domain_update($1,$2,'mentor',$3,$4,$5::jsonb,'update')",[digest,randomUUID(),m.ana,version,JSON.stringify({displayName:'Ana Editada'})]);await editor.query('commit');}
  catch(e){adminError=String((e as {code?:string}).code);await editor.query('rollback');}
  const reply=await pending;
  assert.deepEqual({adminError,cadastro:outcome(reply)},{adminError:null,cadastro:[202,null,[]]},'nenhuma das duas abortada por 40P01/55P03');
  assert.equal(waited,true,'o cadastro esperou o guard (antes de travar a mentora)');
 }finally{await editor.end();}
 assert.equal((await db.query('select display_name from mentor where id=$1',[m.ana])).rows[0].display_name,'Ana Editada');
 assert.deepEqual(await registered(db,'corrida-admin@example.invalid'),[m.ana]);
}));

test('item 3: elevação offline da conta de mesmo e-mail da mentora durante o cadastro → espera o lock da conta e recusa como protegida, sem gravar',async()=>withDb(async({db,url})=>{
 const m=await crossingMentors(db);const anaRef=await refOf('Ana Dados');
 // conta comum cuja chave de e-mail coincide com a linha da mentora (user_id NULL): a elevação a admin a torna protegida no commit
 const owner=await addUser(db,{email:'Ana@Example.invalid',roles:['participant']});
 const domain=async()=>{const s=await fullSnapshot(db);return ['public.participant','public.match','public.api_idempotency'].map(t=>s[t]);};
 const before=await domain();
 let pending:Promise<Reply>=Promise.reject(new Error('afterLock não executou'));pending.catch(()=>{});let waited=false;
 const elevated=await runPrivilegedAccount(['grant-admin','--user-id',owner.id,'--confirm'],{MIGRATION_DATABASE_URL:url},{afterLock:async()=>{
  pending=send(signup('corrida-elevacao@example.invalid',anaRef));waited=await untilBlocked(db,pending,1);
 }});
 assert.deepEqual(elevated,{code:'ok'});
 assert.deepEqual(outcome(await pending),[422,'INVALID_INPUT',['mentor_ref']],'mentora protegida no commit da elevação não recebe match');
 assert.equal(waited,true,'o cadastro esperou o lock da conta dona/mesmo e-mail');
 assert.deepEqual(await domain(),before,'nenhum perfil/match/idempotência');
 assert.equal((await db.query("select count(*)::int n from app_user where email_key='corrida-elevacao@example.invalid'")).rows[0].n,0,'nenhuma conta');
 assert.deepEqual(await registered(db,'corrida-elevacao@example.invalid'),[]);
}));

test('item 3: conta privilegiada de mesmo e-mail criada com o guard tomado → reconferência do conjunto de contas (40001), nada gravado',async()=>withDb(async({db,url})=>{
 const m=await crossingMentors(db);const anaRef=await refOf('Ana Dados');
 const editor=new Client({connectionString:url});await editor.connect();
 try{
  // conta nova (invisível ao cadastro até o commit) entra no conjunto que decide a proteção da mentora
  await editor.query('begin');await editor.query('update internal.agenda_guard set revision=revision+1 where id=1');
  await editor.query("insert into app_user(id,email,status) values(gen_random_uuid(),'ana@example.invalid','active')");
  await editor.query("insert into user_role(user_id,role) select id,'team' from app_user where email_key='ana@example.invalid'");
  const before=await fullSnapshot(db);
  const pending=send(signup('corrida-conta@example.invalid',anaRef));
  const waited=await untilBlocked(db,pending,1);
  await editor.query('commit');
  assert.deepEqual(outcome(await pending),[409,'RETRY_TRANSACTION',[]],'conjunto de contas mudou durante a espera → refazer (protocolo R3)');
  assert.equal(waited,true);
  const after=await fullSnapshot(db);
  for(const t of ['public.participant','public.match','public.audit_event'])assert.equal(after[t],before[t],t);
 }finally{await editor.end();}
 assert.deepEqual(await registered(db,'corrida-conta@example.invalid'),[]);
 // refeito do zero, a mentora agora é protegida e sai do crossing
 assert.deepEqual(outcome(await send(signup('corrida-conta@example.invalid',anaRef))),[422,'INVALID_INPUT',['mentor_ref']]);
}));
