/** Regressão de carregamento: controle de tema não deve puxar CSS de arte da home. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {startUi,type Ui} from './ui-harness';
let ui:Ui;
before(async()=>{ui=await startUi('ui-login-loading');},{timeout:420000});
after(async()=>{await ui?.stop();});
test('login mobile carrega somente estilos utilizados e preserva tema persistente',{timeout:120000},async()=>{
 const {page,context}=await ui.newPage({viewport:{width:390,height:844}});
 try{
  await page.goto(ui.origin+'/login');
  await page.getByLabel('E-mail').waitFor();
  const styles=await page.locator('link[rel="stylesheet"]').evaluateAll(links=>links.map(link=>(link as HTMLLinkElement).href));
  for(const url of styles){
   const response=await fetch(url);assert.equal(response.status,200);
   assert.equal((await response.text()).includes('.face-stage'),false,'login não deve bloquear pintura com CSS da arte da home');
  }
  await page.getByRole('button',{name:'Ativar tema claro'}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');
  await page.reload();await page.getByRole('button',{name:'Ativar tema escuro'}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'light');
  await page.getByRole('button',{name:'Ativar tema escuro'}).click();
  assert.equal(await page.evaluate(()=>document.documentElement.dataset.theme),'dark');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  ui.assertNoLeak();
 }finally{await context.close();}
});
