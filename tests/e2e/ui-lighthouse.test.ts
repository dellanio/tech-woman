/** Lighthouse de produção com sessão sintética apenas em memória. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import type {Page} from 'playwright';
import {chromium} from 'playwright';
import {startUi,type Ui} from './ui-harness';
let ui:Ui;
const root='/fabrica/tech-woman/40-verificacao/evolucao-postgres/WP-004';
const label=process.env.AUDIT_LABEL??'run59-task5-lh';
const results:unknown[]=[];
before(async()=>{ui=await startUi(label);await ui.db.query(readFileSync('scripts/migration/grants-local.sql','utf8'));},{timeout:420000});
after(async()=>{writeFileSync(root+'/logs/'+label+'-scores.json',JSON.stringify(results,null,2));await ui?.stop();});
async function activate(page:Page,admin=false){
 const email=`audit-${randomBytes(6).toString('hex')}@example.invalid`;
 const temp=await ui.temporaryPassword(email);
 if(admin)await ui.db.query("insert into user_role(user_id,role) select id,'admin' from app_user where email=$1",[email]);
 await page.goto(ui.origin+'/login');await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL('**/troca-senha**');
 const secret='Recife-'+randomBytes(16).toString('hex');ui.secrets.add(secret);
 await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(secret);await page.getByLabel('Confirme a nova senha').fill(secret);await page.getByRole('button',{name:/Salvar nova senha/}).click();await page.waitForURL('**/conta');
}

test('Lighthouse quatro telas principais mobile/desktop com privacidade preservada',{timeout:1200000},async()=>{
 const chrome=await chromium.launch({headless:true,args:['--remote-debugging-port=55305','--no-sandbox']});
 const {page,context}=await ui.newPage();
 const worker=spawn(process.execPath,[root+'/run59-task5-lighthouse.mjs'],{stdio:['pipe','pipe','pipe']});
 let stderr='';worker.stderr.on('data',b=>stderr+=b);
 const workerExit=new Promise<void>(resolve=>worker.once('exit',()=>resolve()));
 try{
 for(const screen of ['login','inscricao','conta','admin']){
  await context.clearCookies();
  if(screen==='conta'||screen==='admin')await activate(page,screen==='admin');
  const cookie=(await context.cookies()).map(c=>c.name+'='+c.value).join('; ');
  for(const formFactor of ['mobile','desktop']){
   const name=label+'-'+screen+'-'+formFactor;
   const output=await new Promise<string>((resolve,reject)=>{
    const failed=(code:number|null)=>{worker.stdout.off('data',got);reject(new Error('Lighthouse exit '+code+': '+stderr));};
    let out='';const got=(b:Buffer)=>{out+=b.toString();if(out.includes('\n')){worker.stdout.off('data',got);worker.off('exit',failed);resolve(out.trim());}};
    worker.stdout.on('data',got);worker.once('exit',failed);
    worker.stdin.write(JSON.stringify({url:ui.origin+'/'+screen,cookie,port:55305,name,formFactor,root})+'\n');
   });
   const result=JSON.parse(output) as {scores:Record<string,number>};results.push({...result,screen,applicableCategories:screen==='inscricao'?['performance','accessibility','best-practices','seo']:['performance','accessibility','best-practices'],seoCaveat:screen==='inscricao'?null:'Página privada de conta: robots noindex intencional.'});
  }
 }
 ui.assertNoLeak();
 const failed=results.filter(r=>{const item=r as {scores:Record<string,number>;applicableCategories:string[]};return item.applicableCategories.some(k=>item.scores[k]<85);});
 assert.equal(failed.length,0,JSON.stringify(failed));
 }finally{worker.stdin.end();await workerExit;await context.close();await chrome.close();}
});
