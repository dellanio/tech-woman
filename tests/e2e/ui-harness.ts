/** Harness dos testes de UI: PG16 real (banco próprio por arquivo de teste), Next dev próprio como techwoman_runtime e Chromium Playwright. Sem testes próprios. */
import assert from 'node:assert/strict';
import {spawn,type ChildProcess} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {createWriteStream,mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {chromium,type Browser,type BrowserContext,type Page} from 'playwright';
import {migrate} from '../../scripts/migration/migrate';
import {closeEmailPool,createMemoryTransport,runEmailWorkerOnce,type EmailMessage} from '../../src/lib/email';

export const PORT=55304;
export const ORIGIN=`http://127.0.0.1:${PORT}`;
const roleUrl=(url:string,role:string)=>{const u=new URL(url);u.searchParams.set('options',`-c role=${role} -c jit=off`);return u.toString();};
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));

export type Ui={
 origin:string;db:Pool;browser:Browser;evidence:string;appLog:string;
 /** Segredos vistos pelo teste (só memória): usados para varrer DOM, URL, console e log do app. */
 secrets:Set<string>;
 /** Esvazia a fila com transporte em memória; segredos ficam só no retorno. */
 drain():Promise<EmailMessage[]>;
 /** Cadastro público real (202) + worker fake → senha temporária em memória. */
 temporaryPassword(email:string):Promise<string>;
 newPage(options?:{viewport?:{width:number;height:number}}):Promise<{context:BrowserContext;page:Page;console:string[]}>;
 /** Nenhum segredo conhecido no log do app nem nas mensagens de console capturadas. */
 assertNoLeak(extra?:string[]):void;
 stop():Promise<void>;
};

export async function startUi(name:string):Promise<Ui>{
 const base=process.env.MIGRATION_DATABASE_URL;assert.ok(base,'MIGRATION_DATABASE_URL (PG próprio) obrigatório');
 const evidence=process.env.EVIDENCE_DIR;assert.ok(evidence,'EVIDENCE_DIR durável obrigatório');mkdirSync(resolve(evidence,'logs'),{recursive:true});
 const control=new Pool({connectionString:base});const database='tw_ui_'+randomUUID().replace(/-/g,'');
 for(const role of ['techwoman_runtime','techwoman_mailer'])if(!(await control.query('select 1 from pg_roles where rolname=$1',[role])).rowCount)await control.query(`create role ${role} nologin`);
 await control.query(`create database ${database}`);
 const u=new URL(base);u.pathname='/'+database;const url=u.toString();
 await migrate(url);
 const db=new Pool({connectionString:url,max:4,options:'-c jit=off'});
 process.env.MAILER_DATABASE_URL=roleUrl(url,'techwoman_mailer');
 const appLog=resolve(evidence,'logs',`${name}-app-${new Date().toISOString().replace(/[:.]/g,'-')}.log`);
 const out=createWriteStream(appLog);
 const env:NodeJS.ProcessEnv={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'development',DATABASE_URL:roleUrl(url,'techwoman_runtime'),APP_ORIGIN:ORIGIN,SESSION_SECRET:randomBytes(48).toString('hex'),EMAIL_MODE:'fake',SES_SEND_ENABLED:'0',ALLOW_LOCAL_HTTP:'1',NEXT_TELEMETRY_DISABLED:'1'};
 assert.ok(!('MIGRATION_DATABASE_URL' in env)&&!('MAILER_DATABASE_URL' in env),'web nunca recebe credencial de migração nem do mailer');
 const app:ChildProcess=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'dev','-H','127.0.0.1','-p',String(PORT)],{env,stdio:['ignore','pipe','pipe']});
 app.stdout?.pipe(out);app.stderr?.pipe(out);
 let ready=false;
 for(let i=0;i<480&&!ready;i++){
  if(app.exitCode!==null)throw new Error(`Next dev encerrou (exit ${app.exitCode}); veja ${appLog}`);
  try{ready=(await fetch(ORIGIN+'/api/v1/topics')).status<500;}catch{await sleep(500);}
 }
 assert.ok(ready,'Next dev não respondeu');
 const browser=await chromium.launch({headless:true});
 const secrets=new Set<string>();const consoleLines:string[]=[];
 const drain=async()=>{const messages:EmailMessage[]=[];await runEmailWorkerOnce(createMemoryTransport(m=>{messages.push(m);}));for(const m of messages)if(m.secret)secrets.add(m.secret);return messages;};
 return {
  origin:ORIGIN,db,browser,evidence,appLog,secrets,drain,
  async temporaryPassword(email){
   const profile={goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true};
   const res=await fetch(ORIGIN+'/api/v1/registrations/participants',{method:'POST',headers:{'Content-Type':'application/json',Origin:ORIGIN,'Sec-Fetch-Site':'same-origin','Idempotency-Key':randomUUID()},body:JSON.stringify({email,...profile})});
   assert.equal(res.status,202);
   const mail=(await drain()).filter(m=>m.to.toLowerCase()===email.toLowerCase()&&(m.kind==='registration'||m.kind==='temporary_password'));
   assert.equal(mail.length,1,'uma credencial temporária emitida pelo worker fake');
   return mail[0].secret;
  },
  async newPage(options={}){
   const context=await browser.newContext({viewport:options.viewport??{width:1440,height:900},reducedMotion:'reduce'});
   const page=await context.newPage();const lines:string[]=[];
   page.on('console',m=>{lines.push(m.text());consoleLines.push(m.text());});
   page.on('pageerror',e=>{lines.push('pageerror:'+e.message);consoleLines.push('pageerror:'+e.message);});
   return {context,page,console:lines};
  },
  assertNoLeak(extra=[]){
   const log=readFileSync(appLog,'utf8');const all=[...secrets,...extra].filter(s=>s.length>=8);
   for(const s of all){assert.equal(log.includes(s),false,'segredo no log do app');assert.equal(consoleLines.some(l=>l.includes(s)),false,'segredo no console do browser');}
  },
  async stop(){
   await browser.close().catch(()=>undefined);
   if(app.exitCode===null){app.kill('SIGTERM');await Promise.race([new Promise<void>(r=>app.once('exit',()=>r())),sleep(10000)]);if(app.exitCode===null)app.kill('SIGKILL');}
   out.end();await closeEmailPool();await db.end();
   for(let i=0;i<80;i++){if(!(await control.query('select 1 from pg_stat_activity where datname=$1',[database])).rowCount)break;await sleep(50);}
   await control.query(`drop database ${database} with (force)`);await control.end();
  },
 };
}
