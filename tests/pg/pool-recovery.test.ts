/**
 * Resiliência a erro idle do pool (PG16 real): pg_terminate_backend de conexão ociosa não pode derrubar o web (Next filho real) nem o
 * mailer (subprocesso); o erro vira log sanitizado (componente + código) e a próxima requisição/execução usa conexão nova no MESMO PID.
 * Erro de consulta ativa continua rejeitando, sem repetir SQL. TEST_STANDALONE=1 usa `.next/standalone/server.js` (requer pnpm build).
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn,fork,type ChildProcess} from 'node:child_process';
import {readdirSync,readFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {Pool} from 'pg';
import {sql} from 'drizzle-orm';
import {getDb,closeDb} from '../../src/lib/db';
import {runEmailWorkerOnce,createDiscardTransport,closeEmailPool} from '../../src/lib/email';
import {withDb,addUser,sessionFor} from './identity-harness.test';

const RAW=[/terminating connection/i,/administrator command/i,/postgres(ql)?:\/\//i,/password/i,/\n\s+at /];
const named=(url:string,app:string)=>{const u=new URL(url);u.searchParams.set('application_name',app);return u.toString();};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function waitFor<T>(what:string,probe:()=>Promise<T|undefined>|T|undefined,timeoutMs=15_000):Promise<T>{
 const until=Date.now()+timeoutMs;
 for(;;){const v=await probe();if(v!==undefined)return v;if(Date.now()>until)throw new Error('timeout: '+what);await sleep(100);}
}
const pgCode=(error:unknown):unknown=>{if(!error||typeof error!=='object')return undefined;return Reflect.get(error,'code')??pgCode(Reflect.get(error,'cause'));};
function freePort(){return new Promise<number>((ok,fail)=>{const s=createServer();s.once('error',fail);s.listen(0,'127.0.0.1',()=>{const a=s.address();s.close(()=>typeof a==='object'&&a?ok(a.port):fail(new Error('sem porta')));});});}
/** PIDs do processo e descendentes (/proc): next dev roda o servidor num filho; standalone é um processo só. */
function processTree(root:number){
 const parent=new Map<number,number>();
 for(const entry of readdirSync('/proc')){if(!/^\d+$/.test(entry))continue;try{const stat=readFileSync(`/proc/${entry}/stat`,'utf8');parent.set(Number(entry),Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[1]));}catch{}}
 const tree=[root];for(let i=0;i<tree.length;i++)for(const [pid,ppid] of parent)if(ppid===tree[i])tree.push(pid);
 return tree.sort((a,b)=>a-b);
}
const idleBackends=async(db:Pool,app:string)=>(await db.query("select pid from pg_stat_activity where application_name=$1 and state='idle'",[app])).rows.map((r:{pid:number})=>r.pid);
const terminate=async(db:Pool,pids:number[])=>{for(const pid of pids)assert.equal((await db.query('select pg_terminate_backend($1) t',[pid])).rows[0].t,true);};
const gone=async(db:Pool,pids:number[])=>(await db.query('select 1 from pg_stat_activity where pid=any($1::int[])',[pids])).rowCount===0?true:undefined;
/** Mata o filho também se o runner receber SIGINT/SIGTERM; a limpeza normal espera a saída real antes do DROP do harness. */
async function supervised<T>(child:ChildProcess,fn:()=>Promise<T>):Promise<T>{
 const onSignal=(signal:NodeJS.Signals)=>{child.kill('SIGKILL');process.kill(process.pid,signal);};
 process.once('SIGINT',onSignal);process.once('SIGTERM',onSignal);
 try{return await fn();}finally{
  process.removeListener('SIGINT',onSignal);process.removeListener('SIGTERM',onSignal);
  if(child.exitCode===null&&child.signalCode===null){const exited=new Promise<void>(r=>child.once('exit',()=>r()));child.kill('SIGTERM');await exited;}
 }
}
const exitOf=(child:ChildProcess)=>child.exitCode!==null||child.signalCode!==null?`exit ${child.exitCode??child.signalCode}`:undefined;

test('web: idle backend terminado não derruba o Next; log sanitizado; próxima sessão autenticada 200 no mesmo PID',async()=>withDb(async({db,url,runtimeUrl})=>{
 const port=await freePort(),origin=`http://127.0.0.1:${port}`,app='tw_pool_web',standalone=process.env.TEST_STANDALONE==='1';
 const dbName=new URL(url).pathname.slice(1),secret=String(process.env.SESSION_SECRET);
 const user=await addUser(db),token=await sessionFor(db,user.id);
 const child=spawn(process.execPath,standalone?['.next/standalone/server.js']:['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port',String(port)],{
  stdio:['ignore','pipe','pipe'],
  env:{PATH:process.env.PATH,NODE_ENV:standalone?'production':'development',PORT:String(port),HOSTNAME:'127.0.0.1',DATABASE_URL:named(runtimeUrl,app),SESSION_SECRET:secret,APP_ORIGIN:origin,EMAIL_MODE:'fake',SES_SEND_ENABLED:'0',ALLOW_LOCAL_HTTP:'1',NEXT_TELEMETRY_DISABLED:'1'},
 });
 let output='';for(const s of [child.stdout!,child.stderr!])s.on('data',(c:Buffer)=>{output+=c.toString();});
 await supervised(child,async()=>{
  const session=()=>fetch(origin+'/api/v1/auth/session',{headers:{Cookie:`tw_session=${token}`},signal:AbortSignal.timeout(120_000)});
  await waitFor('web',async()=>{if(exitOf(child))throw new Error('Next encerrou antes de subir');try{return (await fetch(origin+'/api/v1/auth/session',{signal:AbortSignal.timeout(120_000)})).status<500?true:undefined;}catch{return undefined;}},240_000);
  const first=await session();assert.equal(first.status,200);assert.equal((await first.json()).data.state,'authenticated');
  const pidsBefore=processTree(child.pid!);
  const idle=await waitFor('conexão idle do web',async()=>{const p=await idleBackends(db,app);return p.length?p:undefined;});
  const mark=output.length;
  await terminate(db,idle);await waitFor('backend encerrado',()=>gone(db,idle));
  const logged=await waitFor('log do erro idle',()=>{if(exitOf(child))throw new Error('Next morreu: '+exitOf(child));return output.slice(mark).includes('pg_pool_idle_error')?output.slice(mark):undefined;},10_000)
   .catch((error:Error)=>{throw new Error(`${error.message}; exit=${exitOf(child)??'vivo'}; log=${output.slice(mark).slice(0,600).replace(/[0-9a-f]{40,}/g,'<redacted>')}`);});
  assert.equal(exitOf(child),undefined,'processo original vivo');
  assert.deepEqual(processTree(child.pid!),pidsBefore,'mesmos PIDs (sem respawn)');
  const after=await session();assert.equal(after.status,200,'próxima sessão autenticada usa conexão nova');assert.equal((await after.json()).data.state,'authenticated');
  assert.deepEqual(processTree(child.pid!),pidsBefore);
  const line=logged.split('\n').find(l=>l.includes('pg_pool_idle_error'));
  assert.deepEqual(JSON.parse(line!.slice(line!.indexOf('{'))),{event:'pg_pool_idle_error',component:'web',code:'57P01'});
  for(const raw of RAW)assert.doesNotMatch(logged,raw,'log sem mensagem bruta do PG/stack/URL');
  for(const leak of [dbName,secret,token,app])assert.equal(output.includes(leak),false,'log sem nome do banco, segredo, token ou connectionString');
 });
}));

test('mailer: idle backend terminado não mata o subprocesso; próxima execução vazia no mesmo PID, sem envio',async()=>withDb(async({db})=>{
 const app='tw_pool_mailer',mailerUrl=named(String(process.env.MAILER_DATABASE_URL),app);
 const child=fork('tests/pg/pool-recovery-worker.ts',{execArgv:['--import','tsx'],stdio:['ignore','pipe','pipe','ipc'],env:{PATH:process.env.PATH,NODE_ENV:'production',MAILER_DATABASE_URL:mailerUrl}});
 let output='';for(const s of [child.stdout!,child.stderr!])s.on('data',(c:Buffer)=>{output+=c.toString();});
 const messages:{ready?:boolean;recovered?:boolean;claimed?:number;pid?:number}[]=[];child.on('message',m=>messages.push(m as typeof messages[number]));
 await supervised(child,async()=>{
  const ready=await waitFor('worker pronto',()=>{if(exitOf(child))throw new Error('worker saiu: '+exitOf(child));return messages.find(m=>m.ready);},60_000);
  assert.equal(ready.pid,child.pid);
  const idle=await waitFor('conexão idle do mailer',async()=>{const p=await idleBackends(db,app);return p.length?p:undefined;});
  await terminate(db,idle);await waitFor('backend encerrado',()=>gone(db,idle));
  await waitFor('log do erro idle',()=>{if(exitOf(child))throw new Error('mailer morreu: '+exitOf(child));return output.includes('pg_pool_idle_error')?true:undefined;},10_000);
  assert.equal(exitOf(child),undefined,'processo original vivo');
  const exited=new Promise<number|null>(r=>child.once('exit',code=>r(code)));
  child.send({run:true});
  const recovered=await waitFor('segunda execução',()=>messages.find(m=>m.recovered)??(exitOf(child)?messages.find(m=>m.recovered)??{recovered:false}:undefined),30_000);
  assert.deepEqual(recovered,{recovered:true,claimed:0,pid:child.pid},'mesmo PID, fila vazia, nada enviado');
  assert.equal(await exited,0);
  const line=output.split('\n').find(l=>l.includes('pg_pool_idle_error'));
  assert.deepEqual(JSON.parse(line!.slice(line!.indexOf('{'))),{event:'pg_pool_idle_error',component:'mailer',code:'57P01'});
  for(const raw of RAW)assert.doesNotMatch(output,raw);
  assert.equal(output.includes(app),false);
  assert.deepEqual((await db.query('select (select count(*)::int from email_job) jobs,(select count(*)::int from email_delivery_attempt) attempts')).rows[0],{jobs:0,attempts:0});
 });
}));

test('consulta ativa terminada ainda rejeita, sem repetir SQL nem logar mensagem bruta (web e mailer)',async t=>withDb(async({db,url})=>{
 const logs:string[]=[];t.mock.method(console,'error',(...args:unknown[])=>{logs.push(args.map(String).join(' '));});
 await db.query('create sequence pool_probe');
 process.env.DATABASE_URL=named(url,'tw_pool_active_web');await closeDb();
 const running=getDb().execute(sql`select nextval('pool_probe'), pg_sleep(30)`);
 const failure=assert.rejects(running,(error:unknown)=>pgCode(error)==='57P01');
 const active=await waitFor('consulta ativa',async()=>(await db.query("select pid from pg_stat_activity where application_name='tw_pool_active_web' and state='active'")).rows[0]?.pid as number|undefined);
 await terminate(db,[active]);await failure;
 await sleep(500);
 assert.equal((await db.query('select last_value::int v from pool_probe')).rows[0].v,1,'SQL não foi reexecutado');
 assert.equal((await db.query("select count(*)::int n from pg_stat_activity where application_name='tw_pool_active_web' and state='active'")).rows[0].n,0);
 assert.deepEqual((await getDb().execute(sql`select 1 as ok`)).rows,[{ok:1}],'pool segue utilizável');
 await closeDb();

 process.env.MAILER_DATABASE_URL=named(String(process.env.MAILER_DATABASE_URL),'tw_pool_active_mailer');await closeEmailPool();
 const locker=await db.connect();
 try{
  await locker.query('begin');await locker.query('lock table email_job in access exclusive mode');
  const run=runEmailWorkerOnce(createDiscardTransport());
  const rejected=assert.rejects(run,(error:unknown)=>pgCode(error)==='57P01');
  const blocked=await waitFor('mailer bloqueado',async()=>(await db.query("select pid from pg_stat_activity where application_name='tw_pool_active_mailer' and wait_event_type='Lock'")).rows[0]?.pid as number|undefined);
  await terminate(db,[blocked]);await rejected;
  await sleep(500);
  assert.equal((await db.query("select count(*)::int n from pg_stat_activity where application_name='tw_pool_active_mailer' and state<>'idle'")).rows[0].n,0,'claim não foi repetido');
 }finally{await locker.query('rollback');locker.release();}
 await closeEmailPool();
 for(const line of logs)for(const raw of RAW)assert.doesNotMatch(line,raw);
}));
