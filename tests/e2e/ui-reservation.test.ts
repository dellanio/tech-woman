/** UI real (Chromium + Next dev + PG16): Sua conta, escolha mentora → tema/turma (Recife) → reserva, corrida pela última vaga e histórico anterior. Segredos só em memória. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Page,Request} from 'playwright';
import {startUi,type Ui} from './ui-harness';

let ui:Ui;
// Next dev compila cada rota no primeiro acesso: aquece antes dos testes para que o timeout de navegação meça a UI.
// grants-local.sql é o passo LOCAL_ROLE_SETUP do compose depois das migrations: a home lê event_content como runtime.
before(async()=>{ui=await startUi('ui-reservation');await ui.db.query(readFileSync('scripts/migration/grants-local.sql','utf8'));for(const route of ['/conta','/login','/troca-senha','/inscricao','/','/inscricao/estado/'+'0'.repeat(64)])await fetch(ui.origin+route);},{timeout:420_000});
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
  // textContent: o título é exibido em caixa alta por CSS, o nome real é o do banco
  const lastShown=String(await othersGroup.locator('article h3').nth(2).textContent());
  assert.equal((await ui.db.query('update mentor set active=false where display_name=$1',[lastShown])).rowCount,1);
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


test('participante escolhe mentora sem afinidade → tema e turma em Recife (12 UTC = 09:00) → resumo → 201 sem aprovação; rede caída reenvia a mesma chave; nova turma, nova chave',{timeout:300_000},async()=>{
 const mentorId=await addMentor('Clara Score Zero',['design']);
 const design=await link(mentorId,await addTopic('Design de produto'),1);const research=await link(mentorId,await addTopic('Pesquisa com usuárias'),2);
 const morning=await addCohort(design,futureAt(30,12),{capacity:4});await occupy(morning);
 const later=await addCohort(design,futureAt(31,18,30),{capacity:2});
 const other=await addCohort(research,futureAt(32,15),{hours:2,capacity:5});
 const {page,context,email}=await participantOnAccount('choose');
 const posts=enrollmentRequests(page);
 try{
  await main(page).getByRole('heading',{name:'Suas reservas'}).waitFor();
  await main(page).getByText(/ainda não tem reservas/).waitFor();
  await openMentor(page,'Clara Score Zero');
  // filtro de tema = seleção local das turmas retornadas
  await main(page).getByRole('radio').first().waitFor();
  const filter=main(page).getByLabel('Filtrar por tema');
  assert.deepEqual((await filter.locator('option').allInnerTexts()).slice(1),['Design de produto','Pesquisa com usuárias']);
  assert.equal(await main(page).getByRole('radio').count(),3);
  await filter.selectOption({label:'Pesquisa com usuárias'});
  assert.equal(await main(page).getByRole('radio').count(),1);
  assert.match(await main(page).locator('fieldset.cohort-group').innerText(),/12:00 às 14:00/);
  await filter.selectOption({index:0});
  // horário real em Recife: 12:00 UTC → 09:00; capacidade/ocupação/vagas reais do banco
  const group=main(page).getByRole('group',{name:'Design de produto'});
  const morningLabel=group.locator('label.cohort-option').first();
  const morningText=await morningLabel.innerText();
  assert.match(morningText,/09:00 às 10:00/);assert.match(morningText,/America\/Recife/);assert.doesNotMatch(morningText,/12:00/);
  assert.match(morningText,/3 vagas disponíveis de 4 · 1 ocupada/);
  assert.match(await group.locator('label.cohort-option').nth(1).innerText(),/15:30 às 16:30/);
  await morningLabel.getByRole('radio').check();
  await main(page).getByRole('button',{name:'Conferir resumo'}).click();
  const summary=main(page).locator('.choice-summary');await summary.waitFor();
  const summaryText=await summary.innerText();
  for(const part of ['Clara Score Zero','Design de produto','09:00 às 10:00','America/Recife'])assert.ok(summaryText.includes(part),`resumo mostra ${part}`);
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Confira sua reserva','foco no passo atual');
  await capture(page,'conta-resumo');
  // rede cai DEPOIS do servidor gravar: a tela não confirma; o reenvio usa a mesma chave e recebe a mesma reserva (replay 201)
  let dropped=false;
  await page.route('**/api/v1/me/enrollments',async route=>{if(route.request().method()!=='POST'||dropped){await route.continue();return;}dropped=true;await route.fetch();await route.abort('internetdisconnected');});
  await main(page).getByRole('button',{name:'Reservar vaga'}).click();
  await alertText(page,/Sem conexão/);
  assert.equal(await main(page).getByText('Reserva confirmada').count(),0,'sem falsa confirmação');
  assert.ok((await summary.innerText()).includes('Clara Score Zero'),'contexto preservado');
  await page.unroute('**/api/v1/me/enrollments');
  const [created]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/me/enrollments'),main(page).getByRole('button',{name:'Tentar novamente'}).click()]);
  assert.equal(created.status(),201);
  assert.equal(posts.length,2);
  const keys=posts.map(r=>r.headers()['idempotency-key']);
  assert.match(keys[0],/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);assert.equal(keys[1],keys[0],'mesma chave no reenvio');
  assert.deepEqual(posts.map(r=>r.postDataJSON()),[{cohortId:morning},{cohortId:morning}],'mesmo corpo, sem participantId');
  for(const r of posts)assert.ok((r.headers()['x-csrf-token']??'').length>0);
  const done=main(page).getByRole('status').filter({hasText:'Reserva confirmada'});await done.waitFor();
  const doneText=await done.innerText();
  assert.match(doneText,/Design de produto/);assert.match(doneText,/09:00 às 10:00/);
  assert.match(doneText,/fila de envio/);assert.match(doneText,/não confirma entrega/);assert.match(doneText,/continua valendo mesmo se o e-mail falhar/);assert.match(doneText,/NÃO ENVIADA/);
  assert.doesNotMatch(doneText,/aguard|em análise|aprovad|enviamos|foi enviad|entregue/i);
  const rows=(await ui.db.query<{status:string}>("select e.status from enrollment e join participant p on p.id=e.participant_id where p.email=$1 and e.cohort_id=$2",[email,morning])).rows;
  assert.deepEqual(rows.map(r=>r.status),['active'],'uma reserva só, apesar do reenvio');
  assert.equal((await ui.db.query("select 1 from email_job j join enrollment e on e.id=j.enrollment_id join participant p on p.id=e.participant_id where p.email=$1 and j.kind='reservation'",[email])).rowCount,1,'e-mail de reserva enfileirado');
  // Suas reservas (GET próprio) mostra a reserva real
  const list=main(page).locator('.enrollment-list');
  await list.getByText('Design de produto').waitFor();
  const listText=await list.innerText();
  assert.match(listText,/Clara Score Zero/);assert.match(listText,/09:00 às 10:00/);assert.match(listText,/Ativa/);
  await capture(page,'conta-reserva-confirmada');
  // outra reserva: outra turma → outra chave
  await main(page).getByRole('button',{name:'Fazer outra reserva'}).click();
  await openMentor(page,'Clara Score Zero');
  await main(page).getByRole('group',{name:'Pesquisa com usuárias'}).getByRole('radio').check();
  await main(page).getByRole('button',{name:'Conferir resumo'}).click();
  const [second]=await Promise.all([page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/me/enrollments'),main(page).getByRole('button',{name:'Reservar vaga'}).click()]);
  assert.equal(second.status(),201);
  assert.equal(posts.length,3);assert.notEqual(posts[2].headers()['idempotency-key'],keys[0],'nova seleção, nova chave');
  assert.deepEqual(posts[2].postDataJSON(),{cohortId:other});
  await list.getByText('Pesquisa com usuárias').waitFor();
  assert.equal(await list.locator('li').count(),2);
  void later;
  ui.assertNoLeak();
 }finally{await context.close();}
});

/** Leva a participante até o resumo de uma turma (pré-seleção completa antes do envio). */
async function toSummary(page:Page,mentor:string,topic:string,index=0){
 await openMentor(page,mentor);
 await main(page).getByRole('group',{name:topic}).getByRole('radio').nth(index).check();
 await main(page).getByRole('button',{name:'Conferir resumo'}).click();
 await main(page).locator('.choice-summary').waitFor();
}

test('última vaga: dois navegadores com a turma pré-selecionada enviam juntos; um 201, outro 409 amigável que preserva o contexto e atualiza as vagas',{timeout:420_000},async()=>{
 const mentorId=await addMentor('Duda Última Vaga',['dados']);const mt=await link(mentorId,await addTopic('Entrevistas técnicas'));
 const last=await addCohort(mt,futureAt(40,12),{capacity:1});const spare=await addCohort(mt,futureAt(41,13),{capacity:2});
 const a=await participantOnAccount('race-a');const b=await participantOnAccount('race-b');
 try{
  for(const p of [a,b])await toSummary(p.page,'Duda Última Vaga','Entrevistas técnicas',0);
  const wait=(page:Page)=>page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/me/enrollments');
  const [ra,rb]=await Promise.all([wait(a.page),wait(b.page),a.page.getByRole('button',{name:'Reservar vaga'}).click(),b.page.getByRole('button',{name:'Reservar vaga'}).click()]);
  assert.deepEqual([ra.status(),rb.status()].sort(),[201,409],'banco real decide: uma reserva e um conflito');
  const [winner,loser]=ra.status()===201?[a,b]:[b,a];
  assert.equal(((await (ra.status()===409?ra:rb).json()) as {error:{code:string}}).error.code,'COHORT_FULL');
  await main(winner.page).getByRole('status').filter({hasText:'Reserva confirmada'}).waitFor();
  // perdedora: mensagem amigável, nenhuma confirmação, mentora/turma preservadas e caminhos para atualizar ou trocar
  const text=await alertText(loser.page,/ficou sem vagas/);
  assert.match(text,/A reserva não foi feita/);assert.doesNotMatch(text,/409|COHORT_FULL|erro interno|stack/i);
  assert.equal(await main(loser.page).getByText('Reserva confirmada').count(),0);
  const kept=await main(loser.page).locator('.choice-summary').innerText();
  assert.ok(kept.includes('Duda Última Vaga')&&kept.includes('Entrevistas técnicas'),'contexto preservado');
  assert.equal(await main(loser.page).getByRole('button',{name:'Reservar vaga'}).count(),0,'não reenvia a mesma turma lotada');
  await main(loser.page).getByRole('button',{name:'Escolher outra mentora'}).waitFor();
  await capture(loser.page,'conta-ultima-vaga-409');
  // atualizar horários: vagas reais do banco; a turma lotada fica indisponível, a outra continua escolhível
  await main(loser.page).getByRole('button',{name:'Atualizar horários'}).click();
  await main(loser.page).getByRole('status').filter({hasText:/está lotada agora/}).waitFor();
  const options=main(loser.page).getByRole('group',{name:'Entrevistas técnicas'}).locator('label.cohort-option');
  assert.match(await options.nth(0).innerText(),/Turma lotada · 1 de 1 vagas ocupadas/);
  assert.equal(await options.nth(0).getByRole('radio').isDisabled(),true);
  assert.equal(await options.nth(1).getByRole('radio').isDisabled(),false);
  assert.equal(await main(loser.page).getByRole('button',{name:'Conferir resumo'}).isDisabled(),true,'seleção lotada descartada');
  const seats=(await ui.db.query<{n:number}>("select count(*)::int n from enrollment where cohort_id=$1 and status='active'",[last])).rows[0].n;
  assert.equal(seats,1,'capacidade respeitada');
  // escolher a outra turma conclui com nova chave
  await options.nth(1).getByRole('radio').check();await main(loser.page).getByRole('button',{name:'Conferir resumo'}).click();
  const [ok]=await Promise.all([wait(loser.page),main(loser.page).getByRole('button',{name:'Reservar vaga'}).click()]);
  assert.equal(ok.status(),201);assert.deepEqual(ok.request().postDataJSON(),{cohortId:spare});
  ui.assertNoLeak();
 }finally{await a.context.close();await b.context.close();}
});

test('estados: turma encerrada antes de abrir vira vazio com volta; falha de rede ao ler turmas oferece tentar de novo sem perder a mentora',{timeout:300_000},async()=>{
 const empty=await mentorWithCohort('Eva Sem Turma',['dados'],{topic:'Carreira em dados'});
 await mentorWithCohort('Gabi Rede Instável',['dados'],{topic:'Dados na prática'});
 const {page,context}=await participantOnAccount('states');
 try{
  await main(page).locator('article.choice-mentor').first().waitFor();
  // Next dev (StrictMode) pede a lista duas vezes: só muda o banco depois que as duas respostas chegaram
  await page.waitForLoadState('networkidle');
  // a turma fecha depois que a lista foi carregada: a mentora aparece, mas não há turma aberta
  await ui.db.query("update cohort set status='closed' where id=$1",[empty.cohortId]);
  await openMentor(page,'Eva Sem Turma');
  const none=main(page).getByRole('status').filter({hasText:/não tem turma aberta no momento/});await none.waitFor();
  assert.equal(await main(page).getByRole('radio').count(),0,'nenhum horário inventado');
  assert.equal(await main(page).getByRole('button',{name:'Conferir resumo'}).isDisabled(),true);
  await capture(page,'conta-mentora-sem-turma');
  await main(page).getByRole('button',{name:'Escolher outra mentora'}).click();
  await main(page).getByRole('heading',{name:/Escolha sua mentora/}).waitFor();
  // rede cai ao ler turmas: erro acessível e tentar de novo
  await page.route('**/api/v1/mentors/*/cohorts*',r=>r.abort('internetdisconnected'));
  await openMentor(page,'Gabi Rede Instável');
  const failure=await alertText(page,/Não foi possível carregar as turmas/);
  assert.match(failure,/Sem conexão/);assert.doesNotMatch(failure,/TypeError|Failed to fetch|stack/i);
  assert.match(await main(page).locator('.choice-context').innerText(),/Gabi Rede Instável/i,'mentora preservada');
  await page.unroute('**/api/v1/mentors/*/cohorts*');
  await main(page).getByRole('alert').getByRole('button',{name:'Tentar novamente'}).click();
  await main(page).getByRole('group',{name:'Dados na prática'}).getByRole('radio').first().waitFor();
  assert.equal(await main(page).getByRole('alert').count(),0);
 }finally{await context.close();}
});

/**
 * Participante do cadastro anterior (sem conta) com link individual. O token sintético fica só em memória; por ser o caminho da URL antiga,
 * a linha de requisição do Next dev o registra (logging fora do WP-004, como o ?token= da tarefa 1) — por isso não entra em ui.secrets.
 */
async function legacyParticipant(){
 const token=randomBytes(32).toString('hex');
 const email=`legado-${randomBytes(4).toString('hex')}@example.invalid`;
 const id=await one("insert into participant(email,goal,moment,interests,skills,area,token_hash,consent_version,user_id) values($1,'growth','working','[\"dados\"]','[\"analise\"]','dados',encode(sha256(convert_to($2::text,'UTF8')),'hex'),'v0',null) returning id",[email,token]);
 return {id,token,email};
}
const legacyMatch=(participantId:string,mentorId:string,status='approved')=>ui.db.query("insert into match(participant_id,mentor_id,score,reasons,status,origin) values($1,$2,9,'[\"Interesses em comum: dados (+2)\"]',$3,'legacy')",[participantId,mentorId,status]);

test('histórico anterior: link antigo mostra a mentoria legada sem turma/data/hora e orienta a ativação; sem match não promete fila; token inválido não revela conta; Sua conta lista o histórico',{timeout:300_000},async()=>{
 const mentorEmail=`fernanda-${randomBytes(4).toString('hex')}@example.invalid`;
 const mentorId=await one("insert into mentor(email,trajectory,specialties,availability,capacity,active,display_name) values($1,'Vinte anos em dados no Recife.','[\"dados\"]','No evento.',2,true,'Fernanda Legado') returning id",[mentorEmail]);
 const approved=await legacyParticipant();await legacyMatch(approved.id,mentorId);
 const alone=await legacyParticipant();
 const before=(await ui.db.query<{n:number}>("select (select count(*) from enrollment)+(select count(*) from match) n")).rows[0].n;
 const {page,context}=await ui.newPage();
 const choiceCalls:string[]=[];page.on('request',r=>{if(r.url().includes('/api/choice/'))choiceCalls.push(r.method());});
 try{
  await page.goto(`${ui.origin}/inscricao/estado/${approved.token}`);
  const card=main(page).locator('section.state-card');
  await card.getByText('Histórico anterior — sem turma/data/hora registrados').waitFor();
  const text=await card.innerText();
  assert.match(text,/TW-\d{5}/,'protocolo recebido mantido');assert.match(text,/Fernanda Legado/i);assert.match(text,/decisão anterior foi preservada/);
  assert.equal(text.includes(mentorEmail),false,'nenhum e-mail de terceiro');assert.equal(text.includes(approved.email),false,'nem o e-mail do cadastro');
  assert.doesNotMatch(text,/\b\d{1,2}:\d{2}\b/,'nenhum horário inventado para o legado');
  assert.equal(await main(page).getByRole('link',{name:/Ativar ou recuperar acesso/}).getAttribute('href'),'/recuperar-senha');
  assert.equal(await main(page).getByRole('link',{name:/Entrar na conta/}).getAttribute('href'),'/login');
  assert.equal(await main(page).getByRole('button',{name:/Agendar|Reservar|Escolher/}).count(),0,'o link não escolhe nem reserva');
  assert.equal(await page.locator('meta[name="referrer"]').getAttribute('content'),'no-referrer');
  const html=await page.content();assert.equal(html.includes(mentorEmail),false);assert.equal(text.includes(approved.token),false,'token não é exibido');
  await capture(page,'historico-legado-aprovado');
  // sem match: estado honesto, sem fila, aprovação ou revisão prometidas
  await page.goto(`${ui.origin}/inscricao/estado/${alone.token}`);
  await main(page).getByText('Sem mentoria registrada').waitFor();
  const lone=await main(page).locator('section.state-card').innerText();
  assert.doesNotMatch(lone,/fila|aprova|revis|aguard/i);
  assert.equal(await main(page).getByRole('link',{name:/Ativar ou recuperar acesso/}).getAttribute('href'),'/recuperar-senha');
  await capture(page,'historico-legado-sem-mentoria');
  // token inválido: mesma página genérica, sem protocolo nem dado de conta
  await page.goto(`${ui.origin}/inscricao/estado/${randomBytes(32).toString('hex')}`);
  await main(page).getByRole('heading',{name:/Não foi possível abrir este histórico/}).waitFor();
  assert.doesNotMatch(await main(page).innerText(),/TW-\d|@/);
  assert.deepEqual(choiceCalls,[],'a página antiga não consulta nem tenta escolha por token');
  assert.equal((await ui.db.query<{n:number}>("select (select count(*) from enrollment)+(select count(*) from match) n")).rows[0].n,before,'nada criado pelo link');
 }finally{await context.close();}
 // conta ativa com histórico anterior vinculado: aparece em Suas reservas sem turma/data/hora
 const account=await participantOnAccount('legacy-own');
 try{
  await ui.db.query("insert into match(participant_id,mentor_id,score,reasons,status,origin) select p.id,$2,3,'[]','approved','legacy' from participant p where p.email=$1",[account.email,mentorId]);
  await account.page.reload();
  const item=main(account.page).locator('.enrollment-legacy');await item.waitFor();
  const own=await item.innerText();
  assert.match(own,/Histórico anterior — sem turma\/data\/hora registrados/);assert.match(own,/Aprovada no cadastro anterior/);
  assert.doesNotMatch(own,/\b\d{1,2}:\d{2}\b/);
  ui.assertNoLeak();
 }finally{await account.context.close();}
});

test('home: as duas frases explicam a escolha da turma (sem "não um horário" nem "sem marcar data ou horário")',{timeout:120_000},async()=>{
 const {page,context}=await ui.newPage();
 try{
  await page.goto(ui.origin+'/');
  const text=await main(page).innerText();
  assert.doesNotMatch(text,/não um horário|sem marcar data ou horário/);
  assert.match(text,/Você escolhe a mentora e a turma, com data e horário de Recife\./);
  assert.match(text,/Veja os motivos da sugestão, escolha o tema e a turma e reserve sua vaga\./);
 }finally{await context.close();}
});
