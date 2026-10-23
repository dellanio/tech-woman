/** UI real (Chromium + Next dev + PG16): painel da equipe com CRUDs de participantes, mentoras, cruzamentos e usuários, e editor do conteúdo do evento. Segredos só em memória. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Page} from 'playwright';
import {startUi,type Ui} from './ui-harness';

let ui:Ui;
// Next dev compila cada rota no primeiro acesso: aquece antes dos testes para que o timeout de navegação meça a UI.
// grants-local.sql é o passo LOCAL_ROLE_SETUP do compose depois das migrations (event_content lido como runtime).
before(async()=>{ui=await startUi('ui-admin');await ui.db.query(readFileSync('scripts/migration/grants-local.sql','utf8'));for(const route of ['/admin','/admin/evento','/login','/troca-senha','/conta'])await fetch(ui.origin+route);},{timeout:420_000});
after(async()=>{await ui?.stop();});

const unique=(label:string)=>`ui-${label}-${randomBytes(4).toString('hex')}@example.invalid`;
const strong=()=>`Recife-${randomBytes(12).toString('base64url')}`;
const main=(page:Page)=>page.getByRole('main');
/** Alerta da tela (o Next injeta seu próprio route-announcer com role=alert fora do main). */
const alertIn=(page:Page,expected:RegExp)=>main(page).getByRole('alert').filter({hasText:expected});
/** Capturas preliminares (visual final é da tarefa 5): nome descritivo, nunca token/e-mail. */
const capture=async(page:Page,name:string)=>{const dir=resolve(ui.evidence,'capturas','task4');mkdirSync(dir,{recursive:true});await page.screenshot({path:resolve(dir,`${name}.png`),fullPage:true});};

/** Temporária → troca obrigatória → definitiva pela UI; termina em /conta. */
async function activate(page:Page,email:string,temp:string){
 await page.goto(ui.origin+'/login');
 await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();
 await page.waitForURL(u=>u.pathname==='/troca-senha');
 const definitive=strong();ui.secrets.add(definitive);
 await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(definitive);await page.getByLabel('Confirme a nova senha').fill(definitive);
 await page.getByRole('button',{name:/Salvar nova senha/}).click();
 await page.waitForURL(u=>u.pathname==='/conta');
}
/** Conta sintética da organização: cadastro público real (perfil de participante) + papel admin/team gravado como a operação offline faria. */
async function staff(page:Page,role:'admin'|'team'){
 const email=unique(role);const temp=await ui.temporaryPassword(email);
 await ui.db.query('insert into user_role(user_id,role) select id,$2 from app_user where email=$1',[email,role]);
 await activate(page,email,temp);
 await page.goto(ui.origin+'/admin');
 await panel(page).waitFor();
 return email;
}
const panel=(page:Page)=>main(page).getByRole('navigation',{name:'Recursos do painel'});
const tab=(page:Page,name:string)=>panel(page).getByRole('button',{name,exact:true});
const cards=(page:Page,list:string)=>main(page).getByRole('list',{name:list}).getByRole('listitem');

// ---- Fixtures de domínio no PG real (sem conta vinculada, como cadastros anteriores) ----
const one=async(sql:string,params:unknown[])=>String((await ui.db.query<{id:string}>(sql,params)).rows[0].id);
const addParticipant=(email:string,o:{goal?:string;area?:string}={})=>one("insert into participant(email,goal,moment,interests,skills,area,token_hash,consent_version,active) values($1,$2,'working','[\"dados\"]','[\"analise\"]',$3,$4,'v1',true) returning id",[email,o.goal??'growth',o.area??'dados',randomBytes(32).toString('hex')]);

test('painel: anônima vai ao acesso, limitada à troca, participante sem acesso; administração vê 4 recursos e o conteúdo do evento, sem Agenda; lista vazia, erro com retry e paginação',{timeout:420_000},async()=>{
 const {page,context}=await ui.newPage();
 try{
  // anônima → acesso, preservando o destino
  await page.goto(ui.origin+'/admin');
  await page.waitForURL(u=>u.pathname==='/login'&&u.searchParams.get('next')==='/admin');
  // limitada → troca obrigatória, nunca o painel
  const limitedEmail=unique('limited');const limitedTemp=await ui.temporaryPassword(limitedEmail);
  await ui.db.query("insert into user_role(user_id,role) select id,'admin' from app_user where email=$1",[limitedEmail]);
  await page.getByLabel('E-mail').fill(limitedEmail);await page.getByLabel('Senha',{exact:true}).fill(limitedTemp);await page.getByRole('button',{name:'Entrar',exact:true}).click();
  await page.waitForURL(u=>u.pathname==='/troca-senha');
  await page.goto(ui.origin+'/admin');
  await page.waitForURL(u=>u.pathname==='/troca-senha');
  assert.equal(await panel(page).count(),0);
  await context.clearCookies();
  // administração: lista vazia (o próprio perfil da admin é protegido e nunca aparece)
  const adminEmail=await staff(page,'admin');
  for(const name of ['Participantes','Mentoras','Cruzamentos','Usuários'])await tab(page,name).waitFor();
  assert.equal(await tab(page,'Participantes').getAttribute('aria-current'),'page');
  assert.equal(await panel(page).getByRole('link',{name:'Conteúdo do evento'}).getAttribute('href'),'/admin/evento');
  const panelText=await main(page).innerText();
  assert.doesNotMatch(panelText,/Agenda|Nova turma|Novo tema|Catálogo de temas|Aprovar par/);
  assert.equal(await main(page).getByRole('button',{name:/Agenda|turma|tema/i}).count(),0);
  const empty=main(page).getByRole('region',{name:'Participantes'}).getByText(/Nenhuma participante cadastrada ainda/);await empty.waitFor();
  assert.ok(await main(page).getByRole('button',{name:'Cadastrar participante'}).isVisible(),'vazio oferece a ação de cadastro');
  assert.equal((await main(page).innerText()).includes(adminEmail),false,'conta admin nunca aparece no CRUD');
  await capture(page,'admin-participantes-vazio');

  // 22 participantes: 20 na primeira página + "Carregar mais"; títulos são e-mails, nunca IDs nem JSON
  const emails:string[]=[];for(let i=0;i<22;i++){const e=`lista-${String(i).padStart(2,'0')}-${randomBytes(3).toString('hex')}@example.invalid`;emails.push(e);await addParticipant(e);}
  // falha de rede na releitura → erro com retry, sem fingir vazio
  let failed=false;
  await page.route('**/api/v1/admin/participants?**',async route=>{if(failed){await route.continue();return;}failed=true;await route.abort('internetdisconnected');});
  await main(page).getByRole('button',{name:'Atualizar lista'}).click();
  await alertIn(page,/Sem conexão/).waitFor();
  assert.equal(await main(page).getByText(/Nenhuma participante cadastrada ainda/).count(),0,'erro não finge lista vazia');
  await main(page).getByRole('button',{name:'Tentar novamente'}).click();
  await page.unroute('**/api/v1/admin/participants?**');
  await cards(page,'Participantes').first().waitFor();
  assert.equal(await cards(page,'Participantes').count(),20);
  assert.equal(await main(page).getByRole('heading',{name:emails[0],exact:true}).count(),1);
  const firstCard=await cards(page,'Participantes').first().innerText();
  assert.match(firstCard,/Crescimento/);assert.match(firstCard,/Ativa/);
  assert.doesNotMatch(firstCard,/[{}"]|userId|version/);
  await main(page).getByRole('button',{name:'Carregar mais participantes'}).click();
  await page.waitForFunction(()=>document.querySelectorAll('main [aria-label="Participantes"] > li').length===22);
  assert.equal(await main(page).getByRole('button',{name:'Carregar mais participantes'}).count(),0);
  await capture(page,'admin-participantes-lista');
  await context.clearCookies();
  // participante (sem papel da organização) → explicação, sem recurso nem chamada administrativa
  const adminCalls:string[]=[];page.on('request',r=>{if(r.url().includes('/api/v1/admin/'))adminCalls.push(r.url());});
  const participantEmail=unique('participant');await activate(page,participantEmail,await ui.temporaryPassword(participantEmail));
  await page.goto(ui.origin+'/admin');
  await main(page).getByRole('heading',{name:/Painel restrito à organização/}).waitFor();
  assert.equal(await main(page).getByRole('link',{name:/Sua conta/}).getAttribute('href'),'/conta');
  assert.equal(await panel(page).count(),0);
  assert.equal(adminCalls.length,0,'sem papel da organização: nenhuma chamada /admin');

  ui.assertNoLeak();
 }finally{await context.close();}
});
