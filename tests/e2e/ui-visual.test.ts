/** Auditoria técnica T14: Chromium/standalone/PG reais; nenhum sucesso HTTP simulado. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Page} from 'playwright';
import {startUi,type Ui} from './ui-harness';
let ui:Ui;
const label=process.env.AUDIT_LABEL??'run59-task5-initial';
const root='/fabrica/tech-woman/40-verificacao/evolucao-postgres/WP-004';
const records:unknown[]=[];
before(async()=>{ui=await startUi(label);await ui.db.query(readFileSync('scripts/migration/grants-local.sql','utf8'));},{timeout:420000});
after(async()=>{writeFileSync(resolve(root,'logs',label+'-audit.json'),JSON.stringify(records,null,2));await ui?.stop();});
export async function activate(page:Page,admin=false){
 const email=`audit-${randomBytes(6).toString('hex')}@example.invalid`;
 const temp=await ui.temporaryPassword(email);
 if(admin)await ui.db.query("insert into user_role(user_id,role) select id,'admin' from app_user where email=$1",[email]);
 await page.goto(ui.origin+'/login');await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL('**/troca-senha**');
 const secret='Recife-'+randomBytes(16).toString('hex');ui.secrets.add(secret);
 await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(secret);await page.getByLabel('Confirme a nova senha').fill(secret);await page.getByRole('button',{name:/Salvar nova senha/}).click();await page.waitForURL('**/conta');
}
async function audit(page:Page,name:string){
 await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(200);
 const dir=resolve(root,'capturas',label);mkdirSync(dir,{recursive:true});
 await page.screenshot({path:resolve(dir,name+'.png'),fullPage:true});
 const overflow=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));
 await page.addScriptTag({path:resolve(root,'audit-tools/node_modules/axe-core/axe.min.js')});
 const result=await page.evaluate(async()=>{
  const axe=(window as unknown as {axe:{run():Promise<{violations:{id:string;impact:string;nodes:{target:string[];failureSummary:string}[]}[];passes:{id:string}[];incomplete:{id:string}[]}>}}).axe;
  const r=await axe.run();return {violations:r.violations.map(v=>({id:v.id,impact:v.impact,nodes:v.nodes.map(n=>({target:n.target,failureSummary:n.failureSummary}))})),passes:r.passes.map(p=>p.id),incomplete:r.incomplete.map(p=>p.id)};
 });
 const errors=await page.evaluate(()=>Array.from(document.querySelectorAll('input[type=password]')).some(e=>(e as HTMLInputElement).value.length>0));assert.equal(errors,false,'captura sem senha preenchida');
 records.push({name,overflow,...result});
 assert.ok(overflow.scroll<=overflow.viewport,`${name}: overflow ${overflow.scroll}/${overflow.viewport}`);
 assert.equal(result.violations.filter(v=>v.impact==='critical'||v.id==='color-contrast').length,0,`${name}: ${JSON.stringify(result.violations)}`);
}
for(const width of [390,1440])for(const theme of ['light','dark'])test(`T14 ${width} ${theme}: quatro telas, axe, teclado e estados reais`,{timeout:420000},async()=>{
 const {page,context,console:messages}=await ui.newPage({viewport:{width,height:width===390?844:900}});
 try{
 await context.addInitScript(t=>localStorage.setItem('tw-theme',t),theme);
 const suffix=`${width}-${theme}`;
 await page.goto(ui.origin+'/login');await page.getByRole('button',{name:'Entrar',exact:true}).waitFor();
 await page.keyboard.press('Tab');assert.ok(await page.evaluate(()=>document.activeElement!==document.body));
 await audit(page,'login-'+suffix);
 await page.goto(ui.origin+'/inscricao');await page.getByRole('main').getByRole('heading').first().waitFor();await page.waitForLoadState('networkidle');await audit(page,'diagnostico-'+suffix);
 await activate(page);await page.waitForLoadState('networkidle');await audit(page,'conta-vazio-'+suffix);
 await page.route('**/api/v1/me/recommendations**',async r=>{await new Promise(r=>setTimeout(r,1800));await r.continue();});await page.reload();await page.getByText('Carregando sugestões de mentoras…').waitFor();await audit(page,'conta-loading-'+suffix);await page.waitForLoadState('networkidle');await page.unroute('**/api/v1/me/recommendations**');
 await page.route('**/api/v1/me/recommendations**',r=>r.abort('internetdisconnected'));await page.reload();await page.getByRole('main').getByRole('alert').filter({hasText:/Sem conexão/}).waitFor();await audit(page,'conta-erro-'+suffix);await page.unroute('**/api/v1/me/recommendations**');
 await context.clearCookies();await activate(page,true);await page.goto(ui.origin+'/admin');await page.getByRole('navigation',{name:'Recursos do painel'}).waitFor();await page.waitForLoadState('networkidle');await audit(page,'admin-'+suffix);
 await page.goto(ui.origin+'/admin/evento');await page.waitForLoadState('networkidle');await audit(page,'evento-'+suffix);
 assert.equal(messages.filter(m=>m.startsWith('pageerror:')).length,0,'nenhum pageerror');ui.assertNoLeak();
 }finally{await context.close();}
});
