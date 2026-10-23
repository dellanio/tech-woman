/** UI real (Chromium + Next dev + PG16): Sua conta, escolha mentora → tema/turma (Recife) → reserva, corrida pela última vaga e histórico anterior. Segredos só em memória. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Page,Request} from 'playwright';
import {startUi,type Ui} from './ui-harness';

let ui:Ui;
// Next dev compila cada rota no primeiro acesso: aquece antes dos testes para que o timeout de navegação meça a UI.
before(async()=>{ui=await startUi('ui-reservation');for(const route of ['/conta','/login','/troca-senha','/inscricao','/'])await fetch(ui.origin+route);},{timeout:420_000});
after(async()=>{await ui?.stop();});

const unique=(label:string)=>`ui-${label}-${randomBytes(4).toString('hex')}@example.invalid`;
const strong=()=>`Recife-${randomBytes(12).toString('base64url')}`;
const path=(page:Page)=>new URL(page.url()).pathname;
const main=(page:Page)=>page.getByRole('main');
/** Alerta da tela (o Next injeta seu próprio route-announcer com role=alert fora do main). */
const alertText=async(page:Page,expected:RegExp)=>{const a=main(page).getByRole('alert').filter({hasText:expected});await a.waitFor();return (await a.innerText()).trim();};
/** Capturas preliminares (visual final é da tarefa 5): nome descritivo, nunca token/e-mail. */
const capture=async(page:Page,name:string)=>{const dir=resolve(ui.evidence,'capturas','task3');mkdirSync(dir,{recursive:true});await page.screenshot({path:resolve(dir,`${name}.png`),fullPage:true});};

/** Conta de mentora pelo cadastro público real (202) + worker fake → senha temporária só em memória. */
async function mentorTemporaryPassword(email:string){
 const res=await fetch(ui.origin+'/api/v1/registrations/mentors',{method:'POST',headers:{'Content-Type':'application/json',Origin:ui.origin,'Sec-Fetch-Site':'same-origin','Idempotency-Key':randomUUID()},body:JSON.stringify({email,displayName:'Mentora Conta',trajectory:'Trajetória base.',specialties:['design'],availability:'No evento.',legacyCapacity:1,consent:true})});
 assert.equal(res.status,202);
 const mail=(await ui.drain()).filter(m=>m.to.toLowerCase()===email.toLowerCase());assert.equal(mail.length,1);return mail[0].secret;
}
/** Temporária → troca obrigatória → definitiva pela UI; termina em /conta (destino padrão). */
async function activate(page:Page,email:string,temp:string){
 await page.goto(ui.origin+'/login');
 await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();
 await page.waitForURL(u=>u.pathname==='/troca-senha');
 const definitive=strong();ui.secrets.add(definitive);
 await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(definitive);await page.getByLabel('Confirme a nova senha').fill(definitive);
 await page.getByRole('button',{name:/Salvar nova senha/}).click();
 await page.waitForURL(u=>u.pathname==='/conta');
 await page.getByRole('heading',{name:/Sua conta/}).waitFor();
}

test('Sua conta: anônima vai ao acesso, limitada à troca; mentora vê o próprio perfil sem Agenda; administração e equipe chegam ao painel',{timeout:300_000},async()=>{
 const {page,context}=await ui.newPage();
 const recommendationCalls:string[]=[];
 page.on('request',r=>{if(r.url().includes('/api/v1/me/recommendations'))recommendationCalls.push(r.url());});
 try{
  // anônima: Conta aponta para /conta, que leva ao acesso
  await page.goto(ui.origin+'/login');
  assert.equal(await page.locator('header.site-header').getByRole('link',{name:'Conta',exact:true}).getAttribute('href'),'/conta');
  await page.goto(ui.origin+'/conta');
  await page.waitForURL(u=>u.pathname==='/login');
  await page.getByRole('button',{name:'Entrar',exact:true}).waitFor();
  // limitada: /conta nunca aparece como autenticada, vai à troca obrigatória
  const email=unique('mentor');const temp=await mentorTemporaryPassword(email);
  await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();
  await page.waitForURL(u=>u.pathname==='/troca-senha');
  await page.goto(ui.origin+'/conta');
  await page.waitForURL(u=>u.pathname==='/troca-senha');
  assert.equal(await page.getByRole('heading',{name:/Sua conta/}).count(),0);
  const definitive=strong();ui.secrets.add(definitive);
  await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(definitive);await page.getByLabel('Confirme a nova senha').fill(definitive);
  await page.getByRole('button',{name:/Salvar nova senha/}).click();
  await page.waitForURL(u=>u.pathname==='/conta');
  await main(page).getByRole('status').filter({hasText:/Senha definida/}).waitFor();
  // mentora: o próprio perfil e o caminho para virar participante; sem Agenda nem reserva
  const mentorSection=main(page).getByRole('region',{name:/Seu perfil de mentora/});await mentorSection.waitFor();
  assert.match(await mentorSection.innerText(),/turmas e horários são definidos pela organização/i);
  assert.equal(await main(page).getByRole('link',{name:/Adicionar perfil de participante/}).getAttribute('href'),'/inscricao');
  const text=await main(page).innerText();
  assert.doesNotMatch(text,/Agenda|Reservar vaga|Criar turma|Novo tema/);
  assert.equal(await main(page).getByRole('link',{name:/painel/i}).count(),0);
  assert.equal(recommendationCalls.length,0,'sem perfil de participante: nenhuma sugestão pedida');
  await capture(page,'conta-mentora');
  // administração e equipe: acesso ao painel, sem jornada de reserva
  for(const role of ['admin','team']){
   await ui.db.query('delete from user_role where user_id=(select id from app_user where email=$1) and role in (\'admin\',\'team\')',[email]);
   await ui.db.query('insert into user_role(user_id,role) select id,$2 from app_user where email=$1',[email,role]);
   await page.reload();
   const panel=main(page).getByRole('link',{name:/Abrir painel da equipe/});await panel.waitFor();
   assert.equal(await panel.getAttribute('href'),'/admin');
  }
  ui.assertNoLeak();
 }finally{await context.close();}
});
