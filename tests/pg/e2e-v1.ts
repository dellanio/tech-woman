/**
 * E2E atual (API v1, substitui o legado obsoleto): base vazia → bootstrap de roles → migradora (processo próprio) → web standalone só com a
 * credencial runtime → cadastro 202 → job → worker fake em memória (credencial mailer) → login com temporária → troca → reinício do web →
 * sessão e nova senha preservadas; mais o entrypoint real do mailer (`scripts/email-worker.ts --once`, transporte descartável) consumindo um job.
 * Dados e credenciais exclusivamente sintéticos, gerados aqui e nunca impressos. Nenhum e-mail real (fake não atesta entrega SES).
 *
 * Modo padrão (CI): exige MIGRATION_DATABASE_URL (admin de PG16 descartável), `pnpm build` feito e `psql` no PATH.
 * Modo externo (prova da IMAGEM final, orquestrado fora): E2E_EXTERNAL=1, E2E_PHASE=before|after, E2E_WEB_ORIGIN, E2E_ADMIN_URL (base já
 * migrada pela imagem), E2E_MAILER_URL e E2E_STATE (arquivo temporário sintético, apagado na fase after). O orquestrador reinicia o web e roda
 * o mailer da imagem entre as fases.
 */
import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {cpSync,mkdirSync,readdirSync,readFileSync,rmSync,writeFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createServer} from 'node:net';
import {Client,Pool} from 'pg';

const profile={goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true};
type Reply={status:number;json:any;cookie:string|null};
const synthetic=()=>'E2e-'+randomBytes(18).toString('base64url')+'!9a';

function client(origin:string){
 return async function http(path:string,o:{body?:unknown;cookie?:string;csrf?:string;key?:string}={}):Promise<Reply>{
  const headers=new Headers({Origin:origin,'Sec-Fetch-Site':'same-origin'});
  if(o.body!==undefined)headers.set('Content-Type','application/json');
  if(o.cookie)headers.set('Cookie',`tw_session=${o.cookie}`);
  if(o.csrf)headers.set('X-CSRF-Token',o.csrf);
  if(o.key)headers.set('Idempotency-Key',o.key);
  const res=await fetch(origin+path,{method:o.body!==undefined?'POST':'GET',headers,...(o.body!==undefined?{body:JSON.stringify(o.body)}:{}),redirect:'manual'});
  const text=await res.text();const raw=res.headers.get('set-cookie');
  const m=raw?/(?:^|,\s*)tw_session=([^;]*)/.exec(raw):null;
  return {status:res.status,json:text?JSON.parse(text):null,cookie:m&&m[1]?m[1]:null};
 };
}
/** INT-006: porta livre do SO (bind :0). A faixa sorteada 55300..55389 colidia com o cluster das ops do CI (55346). */
function freePort(){return new Promise<number>((ok,fail)=>{const s=createServer();s.once('error',fail);s.listen(0,'127.0.0.1',()=>{const a=s.address();s.close(()=>typeof a==='object'&&a?ok(a.port):fail(new Error('sem porta')));});});}
async function waitUp(origin:string,proc?:ChildProcess){
 for(let i=0;i<240;i++){
  try{const r=await fetch(origin+'/api/v1/auth/session');if(r.status<500)return;}catch{}
  if(proc&&proc.exitCode!==null)throw new Error('web não iniciou');
  await new Promise(r=>setTimeout(r,250));
 }
 throw new Error('timeout aguardando web');
}
/** Worker em memória com a credencial mailer: o segredo só existe na memória deste processo. */
async function drain(mailerUrl:string){
 process.env.MAILER_DATABASE_URL=mailerUrl;
 const email=await import('../../src/lib/email');
 const messages:{kind:string;to:string;secret:string}[]=[];
 const result=await email.runEmailWorkerOnce(email.createMemoryTransport(m=>{messages.push(m);}));
 await email.closeEmailPool();
 return {messages,result};
}

/** Cadastro → job → fake → login limitado → troca. Devolve a conta sintética e a sessão autenticada. */
async function flowBefore(http:ReturnType<typeof client>,mailerUrl:string){
 const addr=`e2e-${randomUUID().slice(0,8)}@example.invalid`;
 const reg=await http('/api/v1/registrations/participants',{body:{email:addr,...profile},key:randomUUID()});
 assert.deepEqual([reg.status,reg.json?.data],[202,{status:'received',next:'check_email'}],'cadastro v1 responde 202');
 const {messages,result}=await drain(mailerUrl);
 assert.equal(result.claimed,1,'job de acesso reivindicado pelo worker');assert.equal(messages.length,1);assert.equal(messages[0].to,addr);
 const temp=messages[0].secret;
 const limited=await http('/api/v1/auth/login',{body:{email:addr,password:temp}});
 assert.deepEqual([limited.status,limited.json?.data],[200,{state:'password_change_required'}],'login com temporária');
 assert.ok(limited.cookie,'cookie de sessão limitada');
 const csrf=await http('/api/v1/auth/csrf',{cookie:limited.cookie!});assert.equal(csrf.status,200);
 const fresh=synthetic();
 const changed=await http('/api/v1/auth/password/change',{body:{currentPassword:temp,newPassword:fresh},cookie:limited.cookie!,csrf:String(csrf.json.data.csrfToken)});
 assert.deepEqual([changed.status,changed.json?.data],[200,{state:'authenticated'}],'troca de senha');assert.ok(changed.cookie);
 const who=await http('/api/v1/auth/session',{cookie:changed.cookie!});
 assert.deepEqual([who.status,who.json?.data?.state,who.json?.data?.user?.roles],[200,'authenticated',['participant']]);
 // segundo cadastro: fica na fila para o entrypoint real do mailer
 const reg2=await http('/api/v1/registrations/participants',{body:{email:`e2e-q-${randomUUID().slice(0,8)}@example.invalid`,...profile},key:randomUUID()});
 assert.equal(reg2.status,202);
 return {addr,temp,fresh,session:changed.cookie!};
}
async function flowAfter(http:ReturnType<typeof client>,s:{addr:string;temp:string;fresh:string;session:string},admin:Pool|Client){
 const who=await http('/api/v1/auth/session',{cookie:s.session});
 assert.deepEqual([who.status,who.json?.data?.state],[200,'authenticated'],'sessão sobrevive ao restart');
 assert.equal((await http('/api/v1/auth/login',{body:{email:s.addr,password:s.temp}})).status,401,'temporária consumida');
 const again=await http('/api/v1/auth/login',{body:{email:s.addr,password:s.fresh}});
 assert.deepEqual([again.status,again.json?.data],[200,{state:'authenticated'}],'nova senha após restart');
 const pending=(await admin.query("select count(*)::int n from email_job where status in ('queued','sending')")).rows[0].n;
 return {pendingJobs:pending,pg:(await admin.query('show server_version')).rows[0].server_version as string};
}

function runNode(args:string[],env:Record<string,string|undefined>){
 const r=spawnSync(process.execPath,["--import","tsx",...args],{encoding:"utf8",env:env as NodeJS.ProcessEnv});
 return {status:r.status,out:(r.stdout??'')+(r.stderr??'')};
}

async function selfManaged(){
 const base=process.env.MIGRATION_DATABASE_URL;assert.ok(base,'MIGRATION_DATABASE_URL de PG16 sintético obrigatória');
 const evidence=process.env.EVIDENCE_DIR;if(evidence)mkdirSync(evidence,{recursive:true});
 const control=new Pool({connectionString:base});const db='tw_e2e_'+randomUUID().replace(/-/g,'');
 const urlFor=(user?:string,password?:string)=>{const u=new URL(base);u.pathname='/'+db;if(user){u.username=user;u.password=password??'';}return u.toString();};
 const pw={MIGRATOR_PASSWORD:randomBytes(18).toString('hex'),RUNTIME_PASSWORD:randomBytes(18).toString('hex'),MAILER_PASSWORD:randomBytes(18).toString('hex')};
 const hide=(t:string)=>Object.values(pw).reduce((x,s)=>x.split(s).join('<redacted>'),t);
 await control.query(`create database ${db}`);
 // Client.end aguarda o socket fechar; Pool.end pode resolver antes disso (pg-pool).
 const admin=new Client({connectionString:urlFor()});let web:ChildProcess|undefined;
 const port=String(await freePort());const origin=`http://127.0.0.1:${port}`;let webErr='';
 const stop=async()=>{if(web&&web.pid!==undefined&&web.exitCode===null&&web.signalCode===null){const w=web;w.kill('SIGTERM');await new Promise<void>(r=>w.once('exit',()=>r()));}};
 try{
  await admin.connect();
  const boot=spawnSync('psql',['-X','-q','-v','ON_ERROR_STOP=1','-f','scripts/migration/bootstrap-local.sql',urlFor()],{encoding:'utf8',env:{...process.env,...pw}});
  assert.equal(boot.status,0,'bootstrap-local.sql: '+hide((boot.stdout??'')+(boot.stderr??'')));
  // migradora em processo próprio, só com a credencial migradora
  const mig=runNode(['scripts/migration/migrate.ts'],{PATH:process.env.PATH,MIGRATION_DATABASE_URL:urlFor('techwoman_migrator',pw.MIGRATOR_PASSWORD),LOCAL_ROLE_SETUP:'1'});
  assert.equal(mig.status,0,'migrate: '+hide(mig.out));
  const files=readdirSync('drizzle').filter(f=>f.endsWith('.sql')).length;
  assert.equal((await admin.query('select count(*)::int n from internal.schema_migration')).rows[0].n,files,'base vazia → todas as migrations');
  cpSync('public','.next/standalone/public',{recursive:true});cpSync('.next/static','.next/standalone/.next/static',{recursive:true});
  const env:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:'production',PORT:port,HOSTNAME:'127.0.0.1',DATABASE_URL:urlFor('techwoman_runtime',pw.RUNTIME_PASSWORD),APP_ORIGIN:origin,SESSION_SECRET:randomBytes(48).toString('hex'),EMAIL_MODE:'fake',SES_SEND_ENABLED:'0',ALLOW_LOCAL_HTTP:'1',NEXT_TELEMETRY_DISABLED:'1'};
  for(const k of Object.keys(env))assert.ok(!/MIGRATION|MAILER/.test(k),'web sem credencial migradora/mailer');
  const start=async()=>{web=spawn(process.execPath,['.next/standalone/server.js'],{env,stdio:['ignore','ignore','pipe']});webErr='';
   web.stderr!.on('data',(c:Buffer)=>{webErr=(webErr+c.toString()).slice(-2000);});
   try{await waitUp(origin,web);}catch(error){throw new Error(`${(error as Error).message} (porta ${port}): ${hide(webErr)}`);}};
  await start();
  const http=client(origin);const mailerUrl=urlFor('techwoman_mailer',pw.MAILER_PASSWORD);
  const state=await flowBefore(http,mailerUrl);
  // entrypoint real do mailer: só MAILER_DATABASE_URL, transporte descartável
  const worker=runNode(['scripts/email-worker.ts','--once'],{PATH:process.env.PATH,MAILER_DATABASE_URL:mailerUrl,EMAIL_MODE:'fake',SES_SEND_ENABLED:'0'});
  assert.equal(worker.status,0,'email-worker: '+hide(worker.out));
  const line=JSON.parse(worker.out.trim().split('\n').filter(l=>l.startsWith('{')).pop()??'{}');
  assert.equal(line.claimed,1,'mailer consumiu o job enfileirado');assert.equal(line.failed,0);
  await stop();await start(); // restart do web
  const after=await flowAfter(http,state,admin);assert.equal(after.pendingJobs,0,'fila vazia');
  const out={mode:'self-managed',flow:'cadastro202→job→fake→login→troca→restart',mailerEntrypoint:{claimed:line.claimed,transport:line.transport},migrations:files,pg:after.pg,webHasMigrationCredential:false,realEmailSent:false};
  if(evidence)writeFileSync(resolve(evidence,'e2e-v1-result.json'),JSON.stringify(out,null,2));
  console.log(JSON.stringify(out));
 }finally{
  try{await stop();}finally{
   try{
    await admin.end();
    // Sem FORCE: conexões remanescentes são falha de cleanup, não devem ser terminadas/ocultadas.
    await control.query(`drop database if exists ${db}`);
   }finally{await control.end();}
  }
 }
}

async function external(){
 const origin=process.env.E2E_WEB_ORIGIN,adminUrl=process.env.E2E_ADMIN_URL,mailerUrl=process.env.E2E_MAILER_URL,stateFile=process.env.E2E_STATE,phase=process.env.E2E_PHASE;
 assert.ok(origin&&adminUrl&&mailerUrl&&stateFile&&(phase==='before'||phase==='after'),'E2E_WEB_ORIGIN/E2E_ADMIN_URL/E2E_MAILER_URL/E2E_STATE/E2E_PHASE');
 const http=client(origin);await waitUp(origin);
 if(phase==='before'){const s=await flowBefore(http,mailerUrl);writeFileSync(stateFile,JSON.stringify(s),{mode:0o600});console.log(JSON.stringify({phase,ok:true}));return;}
 assert.ok(existsSync(stateFile));const s=JSON.parse(readFileSync(stateFile,'utf8'));rmSync(stateFile);
 const admin=new Pool({connectionString:adminUrl});
 try{const after=await flowAfter(http,s,admin);assert.equal(after.pendingJobs,0,'mailer da imagem esvaziou a fila');console.log(JSON.stringify({phase,ok:true,...after}));}
 finally{await admin.end();}
}

(process.env.E2E_EXTERNAL==='1'?external():selfManaged()).then(()=>{process.exitCode=0;},error=>{
 console.error('e2e-v1 falhou:',error instanceof Error?error.message.split('\n')[0].replace(/[A-Za-z0-9_-]{32,}/g,'<redacted>'):'unknown');process.exitCode=1;
});
