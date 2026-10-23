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

// ---- Fixtures de Agenda no PG real (dono da migração: cadastro de tema/turma não é UI desta jornada) ----
const one=async(sql:string,params:unknown[])=>String((await ui.db.query<{id:string}>(sql,params)).rows[0].id);
const addTopic=(name:string)=>one("insert into topic(slug,name,active) values($1,$2,true) returning id",['t-'+randomBytes(4).toString('hex'),name]);
const addMentor=(name:string,specialties:string[])=>one("insert into mentor(email,trajectory,specialties,availability,capacity,active,display_name) values($1,$2,$3,'No evento.',2,true,$4) returning id",[`m-${randomBytes(4).toString('hex')}@example.invalid`,`Trajetória de ${name}.`,JSON.stringify(specialties),name]);
const link=(mentorId:string,topicId:string,position=1)=>one('insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,$3) returning id',[mentorId,topicId,position]);
/** Dia civil futuro às `hourUtc` UTC (12 UTC = 09:00 em Recife, UTC−3 sem horário de verão). */
const futureAt=(days:number,hourUtc:number,minutes=0)=>{const d=new Date();d.setUTCDate(d.getUTCDate()+days);d.setUTCHours(hourUtc,minutes,0,0);return d;};
const addCohort=(mentorTopicId:string,startsAt:Date,o:{hours?:number;capacity?:number}={})=>one("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,$2,$3,$4,'open') returning id",[mentorTopicId,startsAt.toISOString(),new Date(startsAt.getTime()+(o.hours??1)*3600e3).toISOString(),o.capacity??3]);
/** Mentora com um tema e uma turma aberta. */
async function mentorWithCohort(name:string,specialties:string[],o:{topic?:string;days?:number;hourUtc?:number;capacity?:number}={}){
 const mentorId=await addMentor(name,specialties);const topicId=await addTopic(o.topic??`Tema de ${name}`);const mt=await link(mentorId,topicId);
 const cohortId=await addCohort(mt,futureAt(o.days??20,o.hourUtc??12),{capacity:o.capacity});return {mentorId,topicId,mentorTopicId:mt,cohortId};
}
/** Ocupa uma vaga real com outra participante reconciliada (efeitos SQL da reserva: match/job/auditoria). */
async function occupy(cohortId:string){
 const email=`p-${randomBytes(4).toString('hex')}@example.invalid`;
 const user=await one("insert into app_user(id,email,status) values(gen_random_uuid(),$1,'active') returning id",[email]);
 const participant=await one("insert into participant(email,goal,moment,interests,skills,area,token_hash,consent_version,user_id,active) values($1,'growth','working','[\"dados\"]','[\"codigo\"]','dados',$2,'v1',$3,true) returning id",[email,randomBytes(32).toString('hex'),user]);
 await ui.db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[participant,cohortId]);
}
const mentorCard=(page:Page,name:string)=>main(page).locator('article.choice-mentor').filter({has:page.getByRole('heading',{name,exact:true})});
/** Abre a mentora pela lista paginada: carrega mais até o cartão aparecer. */
async function openMentor(page:Page,name:string){
 await main(page).getByRole('heading',{name:/Escolha sua mentora/}).waitFor();
 await main(page).locator('article.choice-mentor').first().waitFor();
 for(let i=0;i<20&&!(await mentorCard(page,name).count());i++){
  const more=main(page).getByRole('button',{name:/Carregar mais mentoras/});
  assert.ok(await more.count(),`mentora ${name} não encontrada na lista`);
  const before=await main(page).locator('article.choice-mentor').count();
  await more.click();
  await page.waitForFunction(n=>document.querySelectorAll('main article.choice-mentor').length>n,before);
 }
 await page.getByRole('button',{name:`Ver temas e turmas de ${name}`,exact:true}).click();
 await main(page).getByRole('heading',{name:/Escolha o tema e a turma/}).waitFor();
}
const enrollmentRequests=(page:Page)=>{const list:Request[]=[];page.on('request',r=>{if(r.method()==='POST'&&new URL(r.url()).pathname==='/api/v1/me/enrollments')list.push(r);});return list;};
/** Participante via cadastro público real + ativação pela UI; termina em /conta. */
async function participantOnAccount(label:string){
 const email=unique(label);const temp=await ui.temporaryPassword(email);const opened=await ui.newPage();
 await activate(opened.page,email,temp);return {...opened,email};
}

test('participante: mais de três sugestões com razões legíveis, outras sem afinidade calculada, carregar mais por cursor e cursor obsoleto oferece recarregar',{timeout:300_000},async()=>{
 // perfil do cadastro: crescimento, interesse dados, habilidade análise, área dados → especialidade "dados" pontua; "design" fica com score 0
 const suggested:string[]=[],zero:string[]=[];
 for(let i=1;i<=5;i++){const name=`Ana Afinidade ${i}`;await mentorWithCohort(name,['dados']);suggested.push(name);}
 for(let i=1;i<=5;i++){const name=`Bia Aberta ${i}`;await mentorWithCohort(name,['design']);zero.push(name);}
 const {page,context}=await participantOnAccount('ranking');
 const calls:string[]=[];page.on('request',r=>{if(r.url().includes('/api/v1/me/recommendations'))calls.push(r.url());});
 try{
  await page.reload();
  const suggestedGroup=main(page).getByRole('group',{name:/Sugestões por afinidade/});await suggestedGroup.waitFor();
  // top3 não trunca: as cinco sugestões aparecem, cada uma com motivos legíveis (rótulos, não slugs)
  for(const name of suggested)await suggestedGroup.getByRole('heading',{name,exact:true}).waitFor();
  const first=await mentorCard(page,suggested[0]).innerText();
  assert.match(first,/Interesses em comum: Dados/);assert.match(first,/Habilidades relacionadas: Análise/);assert.match(first,/pontos/i);
  assert.doesNotMatch(first,/analise|\bdados\b/,'slugs viram rótulos');
  // score 0: grupo próprio, rótulo honesto, sem pontuação nem promessa
  const othersGroup=main(page).getByRole('group',{name:/Outras mentoras com turma aberta/});
  const othersText=await othersGroup.innerText();
  assert.match(othersText,/SEM AFINIDADE CALCULADA/);assert.doesNotMatch(othersText,/0 pontos|\b0\b PONTOS|compatível|ideal|garantid/i);
  assert.equal(await othersGroup.locator('article').count(),3,'primeira página: 8 mentoras (5 sugeridas + 3 outras)');
  // carregar mais com o cursor do servidor
  const [more]=await Promise.all([page.waitForResponse(r=>r.url().includes('/api/v1/me/recommendations')&&r.url().includes('cursor=')),main(page).getByRole('button',{name:/Carregar mais mentoras/}).click()]);
  assert.equal(more.status(),200);
  for(const name of zero)await othersGroup.getByRole('heading',{name,exact:true}).waitFor();
  assert.equal(await main(page).getByRole('button',{name:/Carregar mais mentoras/}).count(),0,'fim da lista');
  await capture(page,'conta-sugestoes');
  // cursor obsoleto: a última mentora entregue deixa de ser elegível → 422 → recarregar do início
  await page.reload();await othersGroup.locator('article').nth(2).waitFor();
  const lastShown=await othersGroup.locator('article h3').nth(2).innerText();
  await ui.db.query('update mentor set active=false where display_name=$1',[lastShown]);
  const [stale]=await Promise.all([page.waitForResponse(r=>r.url().includes('cursor=')),main(page).getByRole('button',{name:/Carregar mais mentoras/}).click()]);
  assert.equal(stale.status(),422);
  await alertText(page,/lista de mentoras mudou/);
  await main(page).getByRole('button',{name:/Recarregar sugestões/}).click();
  await suggestedGroup.getByRole('heading',{name:suggested[0],exact:true}).waitFor();
  assert.equal(await mentorCard(page,lastShown).count(),0,'mentora inelegível sai da lista');
  assert.equal(await main(page).getByRole('alert').count(),0);
  assert.ok(calls.every(u=>!/participantId|userId/.test(u)),'a participante vem da sessão, nunca da URL');
  ui.assertNoLeak();
 }finally{await context.close();}
});

