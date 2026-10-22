/** Smoke real do artefato standalone, dados e credenciais exclusivamente sintéticos. */
import assert from 'node:assert/strict';
import {spawn,execFileSync,type ChildProcess} from 'node:child_process';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,cpSync,writeFileSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {Pool} from 'pg';
import {chromium} from 'playwright';
import {migrate} from '../../scripts/migration/migrate';
import {seedDemo} from '../../scripts/seed-demo';
import {closeDb} from '../../src/lib/db';

async function main(){
 const evidence=process.env.EVIDENCE_DIR;assert.ok(evidence,'EVIDENCE_DIR durável obrigatório');mkdirSync(evidence,{recursive:true});
 const base=process.env.MIGRATION_DATABASE_URL;assert.ok(base,'PG real obrigatório');const control=new Pool({connectionString:base});
 const database='tw_e2e_'+randomUUID().replace(/-/g,'');await control.query(`CREATE DATABASE ${database}`);await control.end();const url=new URL(base);url.pathname='/'+database;
 const password=randomBytes(24).toString('base64url');const adminEmail='admin-smoke@example.invalid';
 process.env.DATABASE_URL=url.toString();process.env.ADMIN_EMAIL=adminEmail;process.env.ADMIN_PASSWORD=password;
 await migrate(url.toString());await seedDemo();await closeDb();
 cpSync('public','.next/standalone/public',{recursive:true});cpSync('.next/static','.next/standalone/.next/static',{recursive:true});
 const origin='http://127.0.0.1:55302';const env:NodeJS.ProcessEnv={PATH:process.env.PATH,NODE_ENV:'production',PORT:'55302',HOSTNAME:'127.0.0.1',DATABASE_URL:url.toString(),APP_ORIGIN:origin,SESSION_SECRET:randomBytes(48).toString('hex'),EMAIL_MODE:'fake',SES_SEND_ENABLED:'0',ALLOW_LOCAL_HTTP:'1',NEXT_TELEMETRY_DISABLED:'1'};
 assert.ok(!('MIGRATION_DATABASE_URL' in env));
 let app:ChildProcess;
 async function start(){app=spawn(process.execPath,['.next/standalone/server.js'],{env,stdio:'ignore'});for(let i=0;i<120;i++){try{const res=await fetch(origin+'/api/mentor');if(res.ok)return;}catch{}if(app.exitCode!==null)throw new Error('Standalone não iniciou');await new Promise(resolve=>setTimeout(resolve,250));}throw new Error('Timeout standalone');}
 async function stop(){if(app.exitCode===null){app.kill('SIGTERM');await new Promise<void>(resolve=>app.once('exit',()=>resolve()));}}
 await start();const browser=await chromium.launch({headless:true,args:['--no-sandbox']});const results:{viewport:string;theme:string;flow:string;consoleErrors:number}[]=[];const tokens:string[]=[];
 try{
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
   const label=viewport.width===1440?'desktop':'mobile';const context=await browser.newContext({viewport,reducedMotion:'reduce'});const page=await context.newPage();const errors:string[]=[];page.on('pageerror',error=>errors.push(error.name));
   await page.goto(origin,{waitUntil:'networkidle'});assert.ok((await page.textContent('body'))?.includes('em Recife, PE.'));
   for(const theme of ['dark','light']){await page.evaluate(t=>{document.documentElement.dataset.theme=t;localStorage.setItem('theme',t);},theme);await page.screenshot({path:resolve(evidence,`home-${label}-${theme}.png`),fullPage:true});}
   await page.getByRole('link',{name:/Quero participar/}).last().click();await page.waitForURL('**/inscricao');
   await page.locator('label').filter({has:page.locator('input[name="goal"][value="growth"]')}).click();
   await page.locator('label').filter({has:page.locator('input[name="moment"]')}).nth(1).click();await page.getByRole('button',{name:/Continuar/}).click();
   await page.locator('label').filter({has:page.locator('input[name="interest"]')}).filter({hasText:'Dados'}).click();
   await page.locator('label').filter({has:page.locator('input[name="skill"]')}).filter({hasText:'Análise'}).click();
   await page.locator('#area').selectOption('dados');await page.locator('#email').fill(`participant-${label}@example.invalid`);
   await page.locator('label').filter({has:page.locator('input[type="checkbox"]:not([name])')}).click();
   const responsePromise=page.waitForResponse(r=>r.url().endsWith('/api/participant')&&r.request().method()==='POST');
   await page.getByRole('button',{name:/Enviar inscrição/}).click();const registration=await (await responsePromise).json();assert.match(registration.protocol,/^TW-/);tokens.push(registration.token);
   await page.getByRole('button',{name:/Agendar mentoria/}).first().waitFor();await page.screenshot({path:resolve(evidence,`suggestions-${label}.png`),fullPage:true});
   await page.getByRole('button',{name:/Agendar mentoria/}).first().click();await page.locator('.choices-section .notice[role="status"]').waitFor();
   await page.goto(origin+'/inscricao/estado/'+registration.token,{waitUntil:'networkidle'});await page.getByRole('heading',{name:/Uma mentoria reservada/}).waitFor();
   await page.screenshot({path:resolve(evidence,`state-${label}.png`),fullPage:true});
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'sem overflow horizontal');
   await page.goto(origin+'/admin',{waitUntil:'networkidle'});await page.locator('#admin-email').fill(adminEmail);await page.locator('#admin-pass').fill(password);await page.getByRole('button',{name:/Entrar no painel/}).click();await page.getByRole('heading',{name:'Encontros possíveis.'}).waitFor();
   await page.screenshot({path:resolve(evidence,`admin-${label}.png`),fullPage:true});assert.equal(errors.length,0,'sem erro JS');results.push({viewport:label,theme:'dark/light home',flow:'cadastro-escolha-estado-admin',consoleErrors:errors.length});await context.close();
  }
  await stop();
  if(process.env.WP001_PG_DATA){execFileSync('runuser',['-u','postgres','--','/usr/lib/postgresql/16/bin/pg_ctl','-D',process.env.WP001_PG_DATA,'restart','-w','-l',resolve(process.env.WP001_PG_DATA,'server.log'),'-o','-p 55431 -h 127.0.0.1 -k /var/run/postgresql'],{stdio:'ignore'});}
  await start();for(const token of tokens){const response=await fetch(origin+'/api/state/'+token);assert.equal(response.status,200);assert.equal((await response.json()).status,'Mentoria reservada');}
  const versionPool=new Pool({connectionString:base});const pgVersion=(await versionPool.query('select version()')).rows[0].version;await versionPool.end();
  writeFileSync(resolve(evidence,'e2e-result.json'),JSON.stringify({results,restart:{app:true,postgres:!!process.env.WP001_PG_DATA,preserved:tokens.length},pgVersion,webHasMigrationCredential:false,databaseSynthetic:true},null,2));
  console.log(JSON.stringify({flows:results.length,consoleErrors:0,restartPreserved:tokens.length,pgVersion,artifact:'standalone'},null,2));
 }finally{await browser.close();await stop();await closeDb();}
}
main().catch(error=>{console.error('Smoke standalone falhou:',error instanceof Error?error.name+': '+error.message.split('\n')[0].replace(/[a-f0-9]{64}/g,'<redacted>'):'unknown',error instanceof Error?error.stack?.split('\n').filter(line=>line.trim().startsWith('at ')).slice(0,3).join('\n'):'');process.exitCode=1;});
