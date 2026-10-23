import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {SESClient} from '@aws-sdk/client-ses';
import {migrate} from '../../scripts/migration/migrate';
import {closeDb} from '../../src/lib/db';
import * as registration from '../../src/lib/registration';
import * as email from '../../src/lib/email';

const base=process.env.MIGRATION_DATABASE_URL;
const roleUrl=(url:string,role:string)=>{const u=new URL(url);u.searchParams.set('options',`-c role=${role} -c jit=off`);return u.toString();};
const READY={EMAIL_MODE:'ses',SES_SEND_ENABLED:'1',SES_IDENTITY_VERIFIED:'1',SES_IAM_AUTHORIZED:'1',SES_ACCOUNT_PRODUCTION:'1',SES_REGION:'us-east-1',SES_FROM:'no-reply@dellanio.com'} as unknown as NodeJS.ProcessEnv;
const message=(to:string):email.EmailMessage=>({jobId:randomUUID(),kind:'registration',to,subject:'assunto',text:'corpo com segredo-sintetico-123',secret:'segredo-sintetico-123'});
const code=async(p:Promise<unknown>)=>{try{await p;return null}catch(e){return e instanceof email.TransportError?e.code:'UNEXPECTED'}};
const stub=(behavior:(n:number)=>Promise<{MessageId?:string}>)=>{const calls:{command:unknown;options?:{abortSignal?:AbortSignal}}[]=[];const client:email.SesLikeClient={async send(command,options){calls.push({command,options});return behavior(calls.length);}};return {calls,client};};
const signal=()=>new AbortController().signal;

/** Espera os backends encerrarem antes do DROP: derrubar socket ainda fechando gera erro assíncrono após o teste. */
const settled=async(control:Pool,name:string)=>{for(let i=0;i<60;i++){if(!(await control.query('select 1 from pg_stat_activity where datname=$1',[name])).rowCount)return;await new Promise(r=>setTimeout(r,50));}};
async function withDb(fn:(ctx:{db:Pool;url:string})=>Promise<void>){
 assert.ok(base,'MIGRATION_DATABASE_URL');const control=new Pool({connectionString:base});const name='tw_tr_'+randomUUID().replace(/-/g,'');const created:string[]=[];
 for(const role of ['techwoman_runtime','techwoman_mailer']){ if(!(await control.query('select 1 from pg_roles where rolname=$1',[role])).rowCount){await control.query(`create role ${role} nologin`);created.push(role);} }
 await control.query(`create database ${name}`);const u=new URL(base);u.pathname='/'+name;const url=u.toString();const db=new Pool({connectionString:url,max:4,options:'-c jit=off'});
 const saved={d:process.env.DATABASE_URL,m:process.env.MAILER_DATABASE_URL};
 try{ await migrate(url);await closeDb();await email.closeEmailPool();process.env.DATABASE_URL=roleUrl(url,'techwoman_runtime');process.env.MAILER_DATABASE_URL=roleUrl(url,'techwoman_mailer');await fn({db,url}); }
 finally{ await closeDb();await email.closeEmailPool();for(const [k,v] of [['DATABASE_URL',saved.d],['MAILER_DATABASE_URL',saved.m]] as const){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  await db.end();await settled(control,name);await control.query(`drop database ${name} with (force)`);for(const role of created)await control.query(`drop role if exists ${role}`).catch(()=>undefined);await control.end(); }
}

test('SES: exige flags estritas atuais e allowlist de destinatários aprovada pelo operador antes de qualquer envio',async()=>{
 assert.equal(email.sesReady(READY),true);
 for(const key of Object.keys(READY))assert.equal(email.sesReady({...READY,[key]:undefined}),false,key);
 assert.equal(email.sesReady({...READY,LOCAL_SEED:'1'}),false);assert.equal(email.sesReady({...READY,BUILDING:'1'}),false);assert.equal(email.sesReady({...READY,SES_FROM:'outro@example.invalid'}),false);
 const off=stub(async()=>({MessageId:'x'}));
 assert.equal(await code(email.createSesTransport({client:off.client,env:{...READY,SES_SEND_ENABLED:'0',[email.SES_ALLOWLIST_ENV]:'a@example.invalid'}}).send(message('a@example.invalid'),signal())),'TRANSPORT_DISABLED');
 const noList=stub(async()=>({MessageId:'x'}));
 assert.equal(await code(email.createSesTransport({client:noList.client,env:READY}).send(message('a@example.invalid'),signal())),'RECIPIENT_NOT_ALLOWED','sem allowlist nada é enviado');
 assert.equal(await code(email.createSesTransport({client:noList.client,env:{...READY,[email.SES_ALLOWLIST_ENV]:' '}}).send(message('a@example.invalid'),signal())),'RECIPIENT_NOT_ALLOWED');
 const some=stub(async()=>({MessageId:'x'}));const t=email.createSesTransport({client:some.client,env:{...READY,[email.SES_ALLOWLIST_ENV]:'ok@example.invalid, Outro@Example.invalid'}});
 assert.equal(await code(t.send(message('estranho@example.invalid'),signal())),'RECIPIENT_NOT_ALLOWED');
 assert.equal(off.calls.length+noList.calls.length+some.calls.length,0,'nenhuma chamada ao cliente fora da allowlist/flags');
});

test('SES: envio único com abort < lease, aceite ≠ entrega, erros classificados sem vazar mensagem',async()=>{
 const env={...READY,[email.SES_ALLOWLIST_ENV]:'ok@example.invalid,outro@example.invalid'};
 const ok=stub(async()=>({MessageId:'0100019abc-def@email.amazonses.com'}));
 const res=await email.createSesTransport({client:ok.client,env}).send(message('OK@Example.invalid'),signal());
 assert.deepEqual(res,{status:'accepted',providerId:'0100019abc-def@email.amazonses.com'});assert.equal(ok.calls.length,1);
 const input=(ok.calls[0].command as {input:{Source:string;Destination:{ToAddresses:string[]};Message:{Body:{Text:{Data:string}}}}}).input;
 assert.deepEqual([input.Source,input.Destination.ToAddresses,input.Message.Body.Text.Data.includes('segredo-sintetico-123')],['Tech Woman <no-reply@dellanio.com>',['OK@Example.invalid'],true]);
 assert.equal(ok.calls[0].options?.abortSignal instanceof AbortSignal,true);
 // o abort do SES expira bem antes do lease de 60s
 const hang=stub(()=>new Promise((_,reject)=>{setTimeout(()=>reject(Object.assign(new Error('aborted'),{name:'AbortError'})),5)}));
 assert.equal(await code(email.createSesTransport({client:hang.client,env,timeoutMs:50}).send(message('ok@example.invalid'),signal())),'TRANSPORT_TIMEOUT');
 let observed:AbortSignal|undefined;const slow=stub(async()=>({MessageId:'x'}));
 const spy:email.SesLikeClient={async send(c,o){observed=o?.abortSignal;return slow.client.send(c,o);}};
 await email.createSesTransport({client:spy,env,timeoutMs:20_000}).send(message('ok@example.invalid'),signal());assert.equal(observed?.aborted,false);
 const parent=new AbortController();parent.abort();let aborted=false;const watch:email.SesLikeClient={async send(_c,o){aborted=o?.abortSignal?.aborted===true;return {MessageId:'x'};}};
 await email.createSesTransport({client:watch,env}).send(message('ok@example.invalid'),parent.signal);assert.equal(aborted,true,'abort do worker propaga');
 assert.throws(()=>email.createSesTransport({client:ok.client,env,timeoutMs:60_000}),/lease/i);assert.throws(()=>email.createSesTransport({client:ok.client,env,timeoutMs:0}));
 const noId=stub(async()=>({}));assert.equal(await code(email.createSesTransport({client:noId.client,env}).send(message('ok@example.invalid'),signal())),'TRANSPORT_ERROR');
 const poison='segredo-no-erro-xyz';
 const boom=stub(async()=>{throw new Error(poison);});let caught:unknown;try{await email.createSesTransport({client:boom.client,env}).send(message('ok@example.invalid'),signal());}catch(e){caught=e;}
 assert.equal(caught instanceof email.TransportError&&caught.code==='TRANSPORT_ERROR'&&!String(caught.message).includes(poison)&&!JSON.stringify(caught).includes(poison),true);
 const rejected=stub(async()=>{throw Object.assign(new Error(poison),{name:'MessageRejected'});});
 assert.equal(await code(email.createSesTransport({client:rejected.client,env}).send(message('ok@example.invalid'),signal())),'TRANSPORT_REJECTED');
 const client=email.createSesClient();assert.equal(await (client as unknown as SESClient).config.maxAttempts(),1);assert.equal(await (client as unknown as SESClient).config.region(),'us-east-1');
});

test('exports históricos confirmRegistration/confirmChoice não enviam e-mail fora do worker, mesmo com flags SES completas',async()=>withDb(async({db,url})=>{
 await db.query(`insert into participant(id,email,goal,moment,interests,skills,token_hash,consent_version) values(1,'h@example.invalid','growth','working','[]','[]','${'d'.repeat(64)}','v1')`);
 await db.query(`insert into mentor(id,email,trajectory,specialties,availability,capacity) values(1,'m@example.invalid','t','[]','a',1)`);
 await db.query("insert into email_attempt(participant_id,status) values(1,'mock-not-sent')");
 const saved={...process.env};let sends=0;const original=SESClient.prototype.send;
 Object.assign(process.env,READY);(SESClient.prototype as unknown as {send:()=>Promise<never>}).send=async()=>{sends++;throw new Error('não deve enviar');};
 try{
  await closeDb();process.env.DATABASE_URL=url; // dono: o histórico só atualiza email_attempt
  const a=await email.confirmRegistration('1','h@example.invalid','TW-00001');const b=await email.confirmChoice('1','1','h@example.invalid','TW-00001','m@example.invalid');
  assert.equal(sends,0);assert.equal(a.startsWith('NÃO ENVIADA'),true);assert.equal(b.startsWith('NÃO ENVIADA'),true);
  assert.deepEqual((await db.query('select status from email_attempt')).rows,[{status:'unavailable-not-sent'}]);
 } finally {(SESClient.prototype as unknown as {send:unknown}).send=original;for(const k of Object.keys(READY))if(saved[k]===undefined)delete process.env[k];else process.env[k]=saved[k];}
}));

const run=(args:string[],env:Record<string,string|undefined>)=>new Promise<{code:number|null;out:string;err:string}>(resolve=>{
 const child=spawn(process.execPath,['--import','tsx','scripts/email-worker.ts',...args],{cwd:process.cwd(),env:Object.fromEntries(Object.entries({PATH:process.env.PATH,HOME:process.env.HOME,...env}).filter(([,v])=>v!==undefined)) as NodeJS.ProcessEnv});
 let out='',err='';child.stdout.on('data',d=>out+=d);child.stderr.on('data',d=>err+=d);child.on('close',c=>resolve({code:c,out,err}));});

test('CLI do worker: --once usa só MAILER_DATABASE_URL, fake descarta segredo e imprime apenas contagens',async()=>withDb(async({db,url})=>{
 await registration.registerParticipant({email:'Cli@Example.invalid',goal:'growth',moment:'working',interests:['dados'],skills:['codigo'],area:'dados',consent:true});
 const env={MAILER_DATABASE_URL:roleUrl(url,'techwoman_mailer'),DATABASE_URL:'postgres://web:web-pw-sintetica@127.0.0.1:1/none',MIGRATION_DATABASE_URL:'postgres://mig:mig-pw-sintetica@127.0.0.1:1/none',SESSION_SECRET:'s'.repeat(40)};
 const first=await run(['--once'],env);
 assert.equal(first.code,0);assert.equal(first.err,'');
 const parsed=JSON.parse(first.out.trim());assert.deepEqual(Object.keys(parsed).sort(),['accepted','cancelled','claimed','failed','simulated','stale','transport','unconfirmed']);
 assert.deepEqual(parsed,{transport:'discard',claimed:1,accepted:0,simulated:1,unconfirmed:0,failed:0,cancelled:0,stale:0});
 const row=(await db.query("select (select status from email_job) status,u.temporary_password_hash h,u.email from app_user u")).rows[0];assert.equal(row.status,'simulated');assert.equal(typeof row.h,'string');
 const output=first.out+first.err;assert.equal(output.includes(row.h)||output.toLowerCase().includes('cli@example')||output.includes('web-pw-sintetica')||output.includes('mig-pw-sintetica'),false);
 const second=await run(['--once'],env);assert.deepEqual([second.code,JSON.parse(second.out.trim()).claimed],[0,0]);
 const noUrl=await run(['--once'],{DATABASE_URL:env.DATABASE_URL,MIGRATION_DATABASE_URL:env.MIGRATION_DATABASE_URL});
 assert.equal(noUrl.code,2,'sem MAILER_DATABASE_URL não herda credencial web nem do migrador');assert.equal((noUrl.out+noUrl.err).includes('web-pw-sintetica')||(noUrl.out+noUrl.err).includes('mig-pw-sintetica'),false);
 const bad=await run(['--forever'],env);assert.equal(bad.code,2);
}));

test('CLI em modo ses sem flags/allowlist recusa sem enviar: job failed, nada de rede',async()=>withDb(async({db,url})=>{
 await registration.registerParticipant({email:'ses@example.invalid',goal:'growth',moment:'working',interests:['dados'],skills:['codigo'],area:'dados',consent:true});
 const r=await run(['--once'],{MAILER_DATABASE_URL:roleUrl(url,'techwoman_mailer'),EMAIL_MODE:'ses'});
 assert.equal(r.code,0);const parsed=JSON.parse(r.out.trim());assert.deepEqual([parsed.transport,parsed.claimed,parsed.failed,parsed.accepted],['ses',1,1,0]);
 assert.deepEqual((await db.query('select a.status,a.error_code from email_delivery_attempt a')).rows,[{status:'failed',error_code:'TRANSPORT_DISABLED'}]);
}));
