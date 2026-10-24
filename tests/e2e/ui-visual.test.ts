/** Auditoria técnica T14: Chromium/standalone/PG reais; nenhum sucesso HTTP simulado. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Page,Locator} from 'playwright';
import {startUi,type Ui} from './ui-harness';
let ui:Ui;
const label=process.env.AUDIT_LABEL??'run59-task5-initial';
const root='/fabrica/tech-woman/40-verificacao/evolucao-postgres/WP-004';
const records:unknown[]=[];
before(async()=>{ui=await startUi(label);await ui.db.query(readFileSync('scripts/migration/grants-local.sql','utf8'));},{timeout:420000});
after(async()=>{writeFileSync(resolve(root,'logs',label+'-audit.json'),JSON.stringify(records,null,2));await ui?.stop();});
async function activate(page:Page,admin=false){
 const email=`audit-${randomBytes(6).toString('hex')}@example.invalid`;
 const temp=await ui.temporaryPassword(email);
 if(admin)await ui.db.query("insert into user_role(user_id,role) select id,'admin' from app_user where email=$1",[email]);
 await page.goto(ui.origin+'/login');await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL('**/troca-senha**');
 const secret='Recife-'+randomBytes(16).toString('hex');ui.secrets.add(secret);
 await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(secret);await page.getByLabel('Confirme a nova senha').fill(secret);await page.getByRole('button',{name:/Salvar nova senha/}).click();await page.waitForURL('**/conta');
}
async function keyboardTo(page:Page,target:Locator){
 for(let i=0;i<30;i++){if(await target.evaluate(e=>e===document.activeElement))return;await page.keyboard.press('Tab');}
 assert.fail('alvo não alcançado somente com Tab');
}
async function audit(page:Page,name:string){
 await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(200);
 const dir=resolve(root,'capturas',label);mkdirSync(dir,{recursive:true});
 assert.equal(await page.locator('input[type=password]').evaluateAll(es=>es.some(e=>(e as HTMLInputElement).value.length>0)),false,'captura sem senha preenchida');
 for(const secret of ui.secrets)assert.equal((await page.locator('body').textContent())?.includes(secret),false,'captura sem segredo no texto');
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
 await audit(page,'login-foco-'+suffix);await page.keyboard.press('Tab');await audit(page,'login-'+suffix);
 for(const route of ['recuperar-senha','redefinir-senha','mentora']){await page.goto(ui.origin+'/'+route);await page.waitForLoadState('networkidle');await audit(page,route+'-'+suffix);}
 await page.goto(ui.origin+'/inscricao');await page.getByRole('main').getByRole('heading').first().waitFor();await page.waitForLoadState('networkidle');await audit(page,'diagnostico-'+suffix);
 await keyboardTo(page,page.locator('input[name=goal]').first());await page.keyboard.press('Space');
 assert.ok(await page.locator('input[name=goal]').first().isChecked());
 assert.equal(await page.locator('#goal-options .choice').first().evaluate(e=>getComputedStyle(e).outlineStyle==='none'),false,'foco visível do radio');
 await keyboardTo(page,page.locator('input[name=moment]').first());await page.keyboard.press('Space');
 await keyboardTo(page,page.getByRole('button',{name:/Continuar/}));await page.keyboard.press('Enter');
 await page.locator('#interest-options').waitFor();await audit(page,'diagnostico-teclado-etapa2-'+suffix);
 await activate(page);await page.waitForLoadState('networkidle');
 await page.route('**/api/v1/auth/session',async r=>{await new Promise(done=>setTimeout(done,1600));await r.continue();});
 await page.reload();const pending=page.locator('.account-home > .auth-panel[aria-busy=true]');await pending.waitFor();
 const pendingBox=await pending.boundingBox();await page.waitForLoadState('networkidle');await page.unroute('**/api/v1/auth/session');
 const readyBox=await page.locator('.account-columns').boundingBox();assert.ok(pendingBox&&readyBox);
 records.push({name:'session-layout-'+suffix,pendingHeight:pendingBox.height,readyHeight:readyBox.height});
 assert.ok(Math.abs(pendingBox.height-readyBox.height)<=80,`sessão: espaço reservado ${pendingBox.height}, pronto ${readyBox.height}`);
await audit(page,'conta-vazio-'+suffix);
 await page.route('**/api/v1/me/recommendations**',async r=>{await new Promise(r=>setTimeout(r,1800));await r.continue();});await page.reload();await page.getByText('Carregando sugestões de mentoras…').waitFor();await audit(page,'conta-loading-'+suffix);await page.waitForLoadState('networkidle');await page.unroute('**/api/v1/me/recommendations**');
 await page.route('**/api/v1/me/recommendations**',r=>r.abort('internetdisconnected'));await page.reload();await page.getByRole('main').getByRole('alert').filter({hasText:/Sem conexão/}).waitFor();await audit(page,'conta-erro-'+suffix);await page.unroute('**/api/v1/me/recommendations**');
 const mentor=String((await ui.db.query("insert into mentor(email,trajectory,specialties,availability,capacity,active,display_name) values($1,'Trajetória sintética para auditoria.','[\"dados\"]','No evento.',2,true,'Mentora Sintética') returning id",['audit-mentor-'+randomBytes(4).toString('hex')+'@example.invalid'])).rows[0].id);
 const topic=String((await ui.db.query("insert into topic(slug,name,active) values($1,'Dados — exemplo sintético',true) returning id",['audit-'+randomBytes(4).toString('hex')])).rows[0].id);
 const mt=String((await ui.db.query('insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,1) returning id',[mentor,topic])).rows[0].id);
 const start=new Date(Date.now()+30*86400e3);start.setUTCHours(12,0,0,0);
 const cohort=String((await ui.db.query("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,$2,$3,1,'open') returning id",[mt,start.toISOString(),new Date(start.getTime()+3600e3).toISOString()])).rows[0].id);
 await page.reload();await page.getByRole('heading',{name:'Mentora Sintética',exact:true}).waitFor();await audit(page,'conta-normal-'+suffix);
 await page.locator('article.choice-mentor').filter({has:page.getByRole('heading',{name:'Mentora Sintética',exact:true})}).getByRole('button').click();
 await page.getByRole('radio').first().waitFor();await page.getByRole('radio').first().check();await audit(page,'reserva-selecao-'+suffix);await page.getByRole('button',{name:'Conferir resumo'}).click();
 // Fechamento real concorrente após a seleção, antes do POST: a API responde 409.
 await ui.db.query("update cohort set status='closed' where id=$1",[cohort]);
 const response=page.waitForResponse(r=>r.url().endsWith('/api/v1/me/enrollments')&&r.request().method()==='POST');
 await page.getByRole('button',{name:/Reservar vaga/}).click();assert.equal((await response).status(),409);
 await page.getByRole('alert').filter({hasText:/A reserva não foi feita/}).waitFor();await audit(page,'reserva-conflito-'+suffix);
 await ui.db.query('update mentor set active=false where id=$1',[mentor]);
 await context.clearCookies();await activate(page,true);await page.goto(ui.origin+'/admin');await page.getByRole('navigation',{name:'Recursos do painel'}).waitFor();await page.waitForLoadState('networkidle');await audit(page,'admin-'+suffix);
 for(const tab of ['Mentoras','Cruzamentos','Usuários']){await page.getByRole('navigation',{name:'Recursos do painel'}).getByRole('button',{name:tab,exact:true}).click();await page.waitForLoadState('networkidle');await audit(page,'admin-'+tab.toLowerCase()+'-'+suffix);}
 await page.goto(ui.origin+'/admin/evento');await page.waitForLoadState('networkidle');await audit(page,'evento-'+suffix);
 records.push({name:'console-'+suffix,messages,expectedNetworkFailures:'401 da introspecção anônima; net::ERR_INTERNET_DISCONNECTED nos aborts deliberados'});
 assert.equal(messages.filter(m=>m.startsWith('pageerror:')).length,0,'nenhum pageerror');
 assert.equal(messages.filter(m=>!m.includes('Failed to load resource')&&!m.includes('Download the React DevTools')&&!m.startsWith('[HMR]')).length,0,'nenhum console de produto');ui.assertNoLeak();
 }finally{await context.close();}
});
