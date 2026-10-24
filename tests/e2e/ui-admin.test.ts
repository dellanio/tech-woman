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

// ---- Agenda mínima no PG real (só para criar uma reserva ativa; o painel não cadastra Agenda) ----
const addTopic=(name:string)=>one("insert into topic(slug,name,active) values($1,$2,true) returning id",['t-'+randomBytes(4).toString('hex'),name]);
const addMentor=(name:string,specialties:string[]=['dados'])=>one("insert into mentor(email,trajectory,specialties,availability,capacity,active,display_name) values($1,$2,$3,'No evento.',2,true,$4) returning id",[`m-${randomBytes(4).toString('hex')}@example.invalid`,`Trajetória de ${name}.`,JSON.stringify(specialties),name]);
async function activeEnrollment(participantId:string){
 // Reservas exigem identidade ativa vinculada, inclusive em fixtures SQL.
 await ui.db.query("with u as (insert into app_user(id,email,status) select gen_random_uuid(),email,'active' from participant where id=$1 and user_id is null returning id) update participant set user_id=(select id from u) where id=$1 and user_id is null",[participantId]);
 const mentorId=await addMentor('Mentora Reserva '+randomBytes(2).toString('hex'));const topicId=await addTopic('Tema Reserva');
 const mt=await one('insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,1) returning id',[mentorId,topicId]);
 const start=new Date();start.setUTCDate(start.getUTCDate()+20);start.setUTCHours(12,0,0,0);
 const cohort=await one("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,$2,$3,3,'open') returning id",[mt,start.toISOString(),new Date(start.getTime()+3600e3).toISOString()]);
 await ui.db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[participantId,cohort]);
}
/** Cartão pelo título: carrega mais páginas até ele aparecer. */
async function card(page:Page,list:string,title:string){
 const items=main(page).getByRole('list',{name:list});
 await main(page).getByRole('list',{name:list}).or(main(page).locator('.admin-empty')).first().waitFor();
 const target=()=>items.getByRole('listitem').filter({has:page.getByRole('heading',{name:title,exact:true})});
 for(let i=0;i<20&&!(await target().count());i++){
  const more=main(page).getByRole('button',{name:new RegExp(`^Carregar mais`)});
  assert.ok(await more.count(),`cartão ${title} não encontrado em ${list}`);
  const before=await items.getByRole('listitem').count();
  await more.click();
  await page.waitForFunction(([l,n])=>document.querySelectorAll(`main [aria-label="${l}"] > li`).length>Number(n),[list,String(before)]);
 }
 return target();
}
type Seen={method:string;url:string;headers:Record<string,string>;body:string|null};
const watch=(page:Page,fragment:string)=>{const seen:Seen[]=[];page.on('request',r=>{if(r.url().includes(fragment))seen.push({method:r.method(),url:r.url(),headers:r.headers(),body:r.postData()});});return seen;};

test('participantes: cadastrar (validação, foco, um POST idempotente), ler por ID antes de editar com If-Match, desativar com aviso, 409 de reserva ativa, reativar e 404 protegido',{timeout:420_000},async()=>{
 const {page,context}=await ui.newPage();
 try{
  await staff(page,'admin');
  const calls=watch(page,'/api/v1/admin/participants');
  await main(page).getByRole('button',{name:'Cadastrar participante'}).click();
  const form=main(page).getByRole('form',{name:'Nova participante'});await form.waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'participant-email','foco no primeiro campo');
  // vazio → erros na ordem da tela e foco no primeiro inválido; nada enviado
  await form.getByRole('button',{name:'Salvar cadastro'}).click();
  await form.getByRole('alert').filter({hasText:/Informe um e-mail válido/}).waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.id),'participant-email');
  assert.equal(calls.filter(c=>c.method==='POST').length,0);
  const email=unique('created');
  await form.getByLabel('E-mail da participante').fill(email);
  await form.getByText('Transição de carreira').click();await form.getByText('Começando',{exact:true}).click();
  await form.locator('#interest-options').getByText('Produto',{exact:true}).click();await form.getByText('Gestão',{exact:true}).click();
  await form.getByLabel('Sua área de atuação').selectOption('outra');await form.getByLabel('Qual área?').fill('Saúde digital');
  // duplo clique: uma intenção (mesma Idempotency-Key) e um único cadastro
  await form.getByRole('button',{name:'Salvar cadastro'}).dblclick();
  await main(page).getByRole('status').filter({hasText:/Participante cadastrada/}).waitFor();
  const posts=calls.filter(c=>c.method==='POST');
  assert.ok(posts.length>=1);assert.equal(new Set(posts.map(p=>p.headers['idempotency-key'])).size,1,'mesma chave em toda tentativa');
  assert.deepEqual(Object.keys(JSON.parse(posts[0].body??'{}')).sort(),['area','consent','email','goal','interests','moment','otherArea','skills']);
  const row=(await ui.db.query("select p.id::text,p.area,p.user_id is not null as linked,u.status from participant p join app_user u on u.id=p.user_id where p.email=$1",[email])).rows;
  assert.equal(row.length,1);assert.equal(row[0].area,'outra: Saúde digital');assert.equal(row[0].status,'pending_activation');
  const id=row[0].id as string;
  assert.doesNotMatch(await main(page).innerText(),/senha temporária:|Recife-|jobId/i);
  const created=await card(page,'Participantes',email);
  assert.match(await created.innerText(),/Transição de carreira/);assert.match(await created.innerText(),/Outra: Saúde digital/);

  // editar: GET por ID (ETag) antes; PATCH só campos do diagnóstico com If-Match = ETag lido
  calls.length=0;
  await created.getByRole('button',{name:`Editar ${email}`}).click();
  const edit=main(page).getByRole('form',{name:'Editar participante'});await edit.waitFor();
  assert.equal(await edit.getByLabel(/E-mail/).count(),0,'e-mail não é editável aqui');
  assert.match(await edit.innerText(),/e-mail só muda em Usuários/i);
  const get=calls.find(c=>c.method==='GET'&&c.url.endsWith(`/participants/${id}`));assert.ok(get,'leitura individual antes de editar');
  await edit.getByText('Liderança',{exact:true}).click();
  await edit.getByRole('button',{name:'Salvar alterações'}).click();
  await main(page).getByRole('status').filter({hasText:/Alterações salvas/}).waitFor();
  const patch=calls.find(c=>c.method==='PATCH');assert.ok(patch);
  assert.equal(patch.headers['if-match'],'"1"');
  const patchBody=JSON.parse(patch.body??'{}');
  for(const k of ['email','consent','userId','token','id','version'])assert.equal(k in patchBody,false,`PATCH sem ${k}`);
  assert.equal(patchBody.goal,'leadership');
  assert.match(await (await card(page,'Participantes',email)).innerText(),/Liderança/);

  // desativar: GET + confirmação com aviso de histórico → DELETE If-Match → Desativada; reativar volta a Ativa
  calls.length=0;
  await (await card(page,'Participantes',email)).getByRole('button',{name:`Desativar ${email}`}).click();
  const confirm=main(page).getByRole('alertdialog',{name:/Desativar participante/});await confirm.waitFor();
  assert.match(await confirm.innerText(),/histórico/i);
  await confirm.getByRole('button',{name:'Confirmar desativação'}).click();
  await main(page).getByRole('status').filter({hasText:/Participante desativada/}).waitFor();
  const del=calls.find(c=>c.method==='DELETE');assert.ok(del);assert.equal(del.headers['if-match'],'"2"');
  assert.ok(calls.findIndex(c=>c.method==='GET'&&c.url.endsWith(`/participants/${id}`))<calls.indexOf(del));
  assert.match(await (await card(page,'Participantes',email)).innerText(),/Desativada/);
  await (await card(page,'Participantes',email)).getByRole('button',{name:`Reativar ${email}`}).click();
  await main(page).getByRole('status').filter({hasText:/Participante reativada/}).waitFor();
  assert.match(await (await card(page,'Participantes',email)).innerText(),/Ativa/);
  assert.equal((await ui.db.query('select active from participant where id=$1',[id])).rows[0].active,true);

  // reserva ativa → 409 orienta cancelar explicitamente; nada muda
  const busyEmail=unique('reserved');const busyId=await addParticipant(busyEmail);await activeEnrollment(busyId);
  await main(page).getByRole('button',{name:'Atualizar lista'}).click();
  await (await card(page,'Participantes',busyEmail)).getByRole('button',{name:`Desativar ${busyEmail}`}).click();
  await main(page).getByRole('alertdialog',{name:/Desativar participante/}).getByRole('button',{name:'Confirmar desativação'}).click();
  await alertIn(page,/reservas ativas/i).waitFor();
  assert.match(await alertIn(page,/reservas ativas/i).innerText(),/cancel/i);
  assert.equal((await ui.db.query('select active from participant where id=$1',[busyId])).rows[0].active,true);
  await main(page).getByRole('button',{name:'Voltar'}).click();

  // protegido depois de listado (e-mail passou a ser de admin) → 404 indistinto, sem dados anteriores
  const hiddenEmail=unique('hidden');await addParticipant(hiddenEmail,{goal:'transition'});
  await main(page).getByRole('button',{name:'Atualizar lista'}).click();
  const hiddenCard=await card(page,'Participantes',hiddenEmail);
  await ui.db.query("with u as (insert into app_user(id,email,status) values(gen_random_uuid(),$1,'active') returning id) insert into user_role(user_id,role) select id,'admin' from u",[hiddenEmail]);
  await hiddenCard.getByRole('button',{name:`Editar ${hiddenEmail}`}).click();
  await alertIn(page,/Não encontramos este registro/).waitFor();
  assert.equal(await main(page).getByRole('form',{name:'Editar participante'}).count(),0,'404 não abre formulário com dados antigos');
  await capture(page,'admin-participante-404');
  ui.assertNoLeak();
 }finally{await context.close();}
});

async function fillMentor(form:ReturnType<Page['getByRole']>,name:string){
 await form.getByLabel('Nome de exibição').fill(name);
 await form.getByLabel('Trajetória',{exact:true}).fill('Experiência em produtos e dados para apoiar outras mulheres.');
 await form.locator('#specialty-options').getByText('Dados',{exact:true}).click();
 await form.getByLabel('Disponibilidade descritiva').fill('Durante o encontro, a combinar.');
 await form.getByLabel('Capacidade legada (participantes)').fill('2');
}
test('mentoras: criar perfil e conta, validar capacidade histórica, ler e editar com ETag, desativar e reativar sem controles de Agenda',{timeout:420_000},async()=>{
 const {page,context}=await ui.newPage();try{
  await staff(page,'admin');await tab(page,'Mentoras').click();
  await main(page).getByRole('button',{name:'Cadastrar mentora',exact:true}).click();
  const form=main(page).getByRole('form',{name:'Nova mentora'});await form.waitFor();
  const email=unique('mentor-created'),name='Mentora Teste '+randomBytes(3).toString('hex');
  await fillMentor(form,name);await form.getByLabel('E-mail da mentora').fill(email);
  await form.getByLabel('Capacidade legada (participantes)').fill('51');
  const calls=watch(page,'/api/v1/admin/mentors');
  await form.getByRole('button',{name:'Salvar cadastro'}).click();
  await form.getByRole('alert').filter({hasText:/1 a 50/}).waitFor();
  assert.equal(calls.filter(c=>c.method==='POST').length,0);
  await form.getByLabel('Capacidade legada (participantes)').fill('2');
  await form.getByRole('button',{name:'Salvar cadastro'}).click();
  await main(page).getByRole('status').filter({hasText:/Mentora cadastrada/}).waitFor();
  const post=calls.find(c=>c.method==='POST');assert.ok(post?.headers['idempotency-key']);
  assert.deepEqual(Object.keys(JSON.parse(post.body??'{}')).sort(),['availability','consent','displayName','email','legacyCapacity','specialties','trajectory']);
  const row=(await ui.db.query('select id::text,user_id,capacity from mentor where email=$1',[email])).rows[0];assert.ok(row.user_id);assert.equal(row.capacity,2);
  calls.length=0;
  await (await card(page,'Mentoras',name)).getByRole('button',{name:`Editar ${name}`}).click();
  const edit=main(page).getByRole('form',{name:'Editar mentora'});await edit.waitFor();
  assert.equal(await edit.getByLabel(/E-mail|demo|userId|senha/i).count(),0);
  assert.match(await edit.innerText(),/não define vagas de turma/);
  await edit.getByLabel('Trajetória',{exact:true}).fill('Trajetória revisada pela organização.');
  await edit.getByRole('button',{name:'Salvar alterações'}).click();
  await main(page).getByRole('status').filter({hasText:/Alterações salvas/}).waitFor();
  const patch=calls.find(c=>c.method==='PATCH');assert.ok(patch);assert.equal(patch.headers['if-match'],'"1"');
  assert.ok(calls.some(c=>c.method==='GET'&&c.url.endsWith('/'+row.id)));
  for(const forbidden of ['email','consent','demo','userId','password'])assert.equal(forbidden in JSON.parse(patch.body??'{}'),false);
  await (await card(page,'Mentoras',name)).getByRole('button',{name:`Desativar ${name}`}).click();
  await main(page).getByRole('alertdialog',{name:'Desativar mentora'}).getByRole('button',{name:'Confirmar desativação'}).click();
  await main(page).getByRole('status').filter({hasText:/Mentora desativada/}).waitFor();
  assert.equal((await ui.db.query('select active from mentor where id=$1',[row.id])).rows[0].active,false);
  await (await card(page,'Mentoras',name)).getByRole('button',{name:`Reativar ${name}`}).click();
  await main(page).getByRole('status').filter({hasText:/Mentora reativada/}).waitFor();
  assert.equal((await ui.db.query('select active from mentor where id=$1',[row.id])).rows[0].active,true);
  assert.equal(await main(page).getByRole('button',{name:/Nova turma|Novo tema|Agenda/}).count(),0);
  ui.assertNoLeak();
 }finally{await context.close();}
});

test('cruzamentos: seletores autorizados, criação com score calculado, suggested/rejected com ETag, cancelamento preserva histórico e legado consultável sem horário',{timeout:420_000},async()=>{
 const {page,context}=await ui.newPage();try{
  await staff(page,'admin');
  const email=unique('match-participant'),participantId=await addParticipant(email),name='Mentora Cruzamento '+randomBytes(3).toString('hex'),mentorId=await addMentor(name);
  const legacyId=await one("insert into match(participant_id,mentor_id,score,reasons,status,origin) values($1,$2,3,'[\"Histórico preservado\"]','approved','legacy') returning id",[participantId,mentorId]);
  const calls=watch(page,'/api/v1/admin/matches');
  await tab(page,'Cruzamentos').click();
  await main(page).getByRole('button',{name:'Criar cruzamento',exact:true}).click();
  const form=main(page).getByRole('form',{name:'Novo cruzamento'});await form.waitFor();
  await form.getByLabel('Participante',{exact:true}).selectOption({label:email});
  await form.getByLabel('Mentora',{exact:true}).selectOption({label:name});
  assert.equal(await form.getByRole('textbox').count(),0,'sem IDs, score ou razões livres');
  await form.getByRole('button',{name:'Salvar cadastro'}).click();
  await main(page).getByRole('status').filter({hasText:/Cruzamento criado/}).waitFor();
  const post=calls.find(c=>c.method==='POST');assert.ok(post?.headers['idempotency-key']);assert.deepEqual(JSON.parse(post.body??'{}'),{participantId,mentorId});
  const current=(await ui.db.query("select id::text,score,reasons from match where participant_id=$1 and mentor_id=$2 and origin='current'",[participantId,mentorId])).rows[0];assert.ok(current.score>0);assert.ok(current.reasons.length>0);
  const crossing=()=>main(page).getByRole('list',{name:'Cruzamentos'}).getByRole('listitem').filter({hasText:'Atual'}).filter({hasText:email});
  await crossing().waitFor();assert.match(await crossing().innerText(),/Dados/);
  calls.length=0;await crossing().getByRole('button',{name:'Editar cruzamento',exact:true}).click();
  const edit=main(page).getByRole('form',{name:'Editar cruzamento'});await edit.waitFor();
  await edit.getByLabel('Situação do cruzamento').selectOption('rejected');await edit.getByRole('button',{name:'Salvar alterações'}).click();
  await main(page).getByRole('status').filter({hasText:/Alterações salvas/}).waitFor();
  const patch=calls.find(c=>c.method==='PATCH');assert.ok(patch);assert.equal(patch.headers['if-match'],'"1"');assert.deepEqual(JSON.parse(patch.body??'{}'),{status:'rejected'});assert.ok(calls.some(c=>c.method==='GET'&&c.url.endsWith('/'+current.id)));
  await crossing().getByRole('button',{name:'Editar cruzamento',exact:true}).click();await edit.waitFor();
  await edit.getByLabel('Situação do cruzamento').selectOption('suggested');await edit.getByRole('button',{name:'Salvar alterações'}).click();await main(page).getByRole('status').filter({hasText:/Alterações salvas/}).waitFor();
  await crossing().getByRole('button',{name:'Cancelar cruzamento',exact:true}).click();
  const confirm=main(page).getByRole('alertdialog',{name:'Cancelar cruzamento'});await confirm.waitFor();assert.match(await confirm.innerText(),/histórico/i);await confirm.getByRole('button',{name:'Confirmar cancelamento'}).click();
  await main(page).getByRole('status').filter({hasText:/Cruzamento cancelado/}).waitFor();
  assert.equal((await ui.db.query('select status from match where id=$1',[current.id])).rows[0].status,'cancelled');
  const legacy=main(page).getByRole('list',{name:'Cruzamentos'}).getByRole('listitem').filter({hasText:'Legado'}).filter({hasText:email});
  assert.match(await legacy.innerText(),/Aprovado/);assert.match(await legacy.innerText(),/sem horário|sem turma/i);assert.equal(await legacy.getByRole('button',{name:'Editar cruzamento'}).count(),0);
  assert.equal((await ui.db.query('select status from match where id=$1',[legacyId])).rows[0].status,'approved');
  assert.equal(await main(page).getByRole('button',{name:/Aprovar|Alocar|Nova turma|Novo tema/}).count(),0);ui.assertNoLeak();
 }finally{await context.close();}
});

async function fillParticipant(form:ReturnType<Page['getByRole']>){
 await form.getByText('Crescimento',{exact:true}).click();await form.getByText('Em atividade',{exact:true}).click();
 await form.locator('#interest-options').getByText('Dados',{exact:true}).click();await form.locator('#skill-options').getByText('Análise',{exact:true}).click();await form.getByLabel('Sua área de atuação').selectOption('dados');
}
test('usuários: criar dois domínios atomicamente, retry idempotente após resposta perdida, editar email/papéis/status com ETag, desativar revoga sessões e admin protegido não aparece',{timeout:420_000},async()=>{
 const {page,context}=await ui.newPage();try{
  const adminEmail=await staff(page,'admin');await tab(page,'Usuários').click();
  await main(page).getByRole('button',{name:'Cadastrar usuário',exact:true}).click();
  const form=main(page).getByRole('form',{name:'Novo usuário'});await form.waitFor();
  assert.equal(await form.getByLabel(/admin|team|administrador|equipe/i).count(),0,'papéis privilegiados nunca são opções');
  const email=unique('dual'),name='Perfil duplo '+randomBytes(3).toString('hex');
  await form.getByLabel('E-mail da conta').fill(email);await form.getByLabel('Perfil de mentora',{exact:true}).check();await fillParticipant(form);await fillMentor(form,name);
  const calls=watch(page,'/api/v1/admin/users');let dropped=false;
  // O servidor grava de verdade; só a resposta é perdida. Retry precisa recuperar a mesma intenção.
  await page.route('**/api/v1/admin/users',async route=>{if(route.request().method()==='POST'&&!dropped){dropped=true;await route.fetch();await route.abort('internetdisconnected');}else await route.continue();});
  await form.getByRole('button',{name:'Salvar cadastro'}).click();await form.getByRole('alert').filter({hasText:/Sem conexão/}).waitFor();
  assert.equal(await form.getByLabel('E-mail da conta').inputValue(),email);assert.equal(await form.getByLabel('Nome de exibição').inputValue(),name);
  await form.getByRole('button',{name:'Tentar salvar novamente'}).click();await main(page).getByRole('status').filter({hasText:/Usuário cadastrado/}).waitFor();await page.unroute('**/api/v1/admin/users');
  const posts=calls.filter(c=>c.method==='POST');assert.equal(posts.length,2);assert.equal(new Set(posts.map(c=>c.headers['idempotency-key'])).size,1);
  const body=JSON.parse(posts[0].body??'{}');assert.deepEqual(body.roles,['participant','mentor']);assert.ok(body.participant);assert.ok(body.mentor);assert.equal('email' in body.participant,false);assert.equal('email' in body.mentor,false);
  const row=(await ui.db.query('select id::text,status from app_user where email=$1',[email])).rows;assert.equal(row.length,1);const id=row[0].id as string;assert.equal(row[0].status,'pending_activation');
  for(const table of ['participant','mentor'])assert.equal((await ui.db.query(`select count(*)::int as n from ${table} where user_id=$1`,[id])).rows[0].n,1);
  assert.equal((await ui.db.query('select count(*)::int as n from user_role where user_id=$1',[id])).rows[0].n,2);
  const changed=unique('email-changed');calls.length=0;
  await (await card(page,'Usuários',email)).getByRole('button',{name:`Editar ${email}`}).click();
  const edit=main(page).getByRole('form',{name:'Editar usuário'});await edit.waitFor();assert.match(await edit.innerText(),/e-mail.*invalida|e-mail.*revoga/i);
  await edit.getByLabel('E-mail da conta').fill(changed);await edit.getByLabel('Perfil de mentora',{exact:true}).uncheck();await edit.getByRole('button',{name:'Salvar alterações'}).click();
  await main(page).getByRole('status').filter({hasText:/Alterações salvas/}).waitFor();
  const patch=calls.find(c=>c.method==='PATCH');assert.ok(patch);assert.equal(patch.headers['if-match'],'"1"');assert.ok(calls.some(c=>c.method==='GET'&&c.url.endsWith('/'+id)));assert.deepEqual(Object.keys(JSON.parse(patch.body??'{}')).sort(),['email','roles']);
  const updated=(await ui.db.query('select email,status,session_version from app_user where id=$1',[id])).rows[0];assert.equal(updated.email,changed);assert.equal(updated.status,'pending_activation');assert.ok(Number(updated.session_version)>0);
  assert.deepEqual((await ui.db.query('select role from user_role where user_id=$1',[id])).rows.map(r=>r.role),['participant']);
  await (await card(page,'Usuários',changed)).getByRole('button',{name:`Editar ${changed}`}).click();await edit.waitFor();
  assert.equal(await edit.getByLabel('Perfil de mentora',{exact:true}).count(),0,'não acrescenta papel removido por toggle sem verificar domínio');
  await edit.getByLabel('Situação da conta').selectOption('active');await edit.getByRole('button',{name:'Salvar alterações'}).click();await main(page).getByRole('status').filter({hasText:/Alterações salvas/}).waitFor();
  await ui.db.query("insert into auth_session(id,user_id,token_hash,scope,session_version,expires_at) select gen_random_uuid(),id,$2,'full',session_version,now()+interval '1 hour' from app_user where id=$1",[id,randomBytes(32).toString('hex')]);
  await (await card(page,'Usuários',changed)).getByRole('button',{name:`Desativar ${changed}`}).click();const confirm=main(page).getByRole('alertdialog',{name:'Desativar usuário'});await confirm.waitFor();assert.match(await confirm.innerText(),/sessões|sessão/);await confirm.getByRole('button',{name:'Confirmar desativação'}).click();await main(page).getByRole('status').filter({hasText:/Usuário desativado/}).waitFor();
  assert.equal((await ui.db.query('select status from app_user where id=$1',[id])).rows[0].status,'disabled');assert.equal((await ui.db.query('select count(*)::int as n from auth_session where user_id=$1 and revoked_at is null',[id])).rows[0].n,0);
  assert.equal((await main(page).innerText()).includes(adminEmail),false);
  const adminId=(await ui.db.query('select id::text from app_user where email=$1',[adminEmail])).rows[0].id as string;
  const protectedStatus=await page.evaluate(async id=>(await fetch('/api/v1/admin/users/'+id)).status,adminId);assert.equal(protectedStatus,404);
  assert.equal((await main(page).innerText()).includes(adminId),false);ui.assertNoLeak();
 }finally{await context.close();}
});
