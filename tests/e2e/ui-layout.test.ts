/** Regressão CLS real: conteúdo autenticado não salta da origem ao substituir loading. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import type {Page} from 'playwright';
import {startUi,type Ui} from './ui-harness';
let ui:Ui;
const root=process.env.AUDIT_ROOT??'/fabrica/tech-woman/40-verificacao/evolucao-postgres/WP-004';
before(async()=>{ui=await startUi('run59-task5-layout-diagnosis');await ui.db.query(readFileSync('scripts/migration/grants-local.sql','utf8'));},{timeout:420000});
after(async()=>{await ui?.stop();});
async function activate(page:Page,admin=false){
 const email=`audit-${randomBytes(6).toString('hex')}@example.invalid`;
 const temp=await ui.temporaryPassword(email);
 if(admin)await ui.db.query("insert into user_role(user_id,role) select id,'admin' from app_user where email=$1",[email]);
 await page.goto(ui.origin+'/login');await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL('**/troca-senha**');
 const secret='Recife-'+randomBytes(16).toString('hex');ui.secrets.add(secret);
 await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(secret);await page.getByLabel('Confirme a nova senha').fill(secret);await page.getByRole('button',{name:/Salvar nova senha/}).click();await page.waitForURL('**/conta');
}
test('diagnóstico CLS: posições reais antes/depois da hidratação e fontes',{timeout:300000},async()=>{
 const {page,context}=await ui.newPage();
 try{
 await activate(page);
 const cold=await ui.browser.newContext({viewport:{width:390,height:844}});await cold.addCookies(await context.cookies());
 const target=await cold.newPage();
 await target.addInitScript(()=>{
  type Shift={value:number;hadRecentInput:boolean;sources:{node:Element;previousRect:DOMRectReadOnly;currentRect:DOMRectReadOnly}[]};
  const observations:unknown[]=[];
  (window as unknown as {layoutObservations:unknown[]}).layoutObservations=observations;
  new PerformanceObserver(list=>{for(const entry of list.getEntries()){
   const e=entry as unknown as Shift;
   observations.push({time:entry.startTime,value:e.value,hadRecentInput:e.hadRecentInput,sources:e.sources.map(s=>({tag:s.node?.tagName,class:s.node?.className,id:s.node?.id,previous:s.previousRect.toJSON(),current:s.currentRect.toJSON()}))});
  }}).observe({type:'layout-shift',buffered:true});
 });
 await target.goto(ui.origin+'/conta');await target.waitForLoadState('networkidle');await target.evaluate(()=>document.fonts.ready);await target.waitForTimeout(1000);
 const entries=await target.evaluate(()=>(window as unknown as {layoutObservations:{value:number;hadRecentInput:boolean}[]}).layoutObservations);
 writeFileSync(root+'/logs/run59-task5-layout-'+(process.env.AUDIT_LABEL??'diagnosis')+'.json',JSON.stringify(entries,null,2));
 assert.ok(entries.filter(e=>!e.hadRecentInput).reduce((sum,e)=>sum+e.value,0)<=0.1,'CLS real da conta deve ser <=0.1');
 assert.ok(await target.getByRole('heading',{name:'Sua conta',exact:true}).isVisible());
 ui.assertNoLeak();await cold.close();
 }finally{await context.close();}
});
