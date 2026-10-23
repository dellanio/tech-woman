/** UI real (Chromium + Next dev + PG16): diagnóstico/cadastro público 202 neutro, cadastro de mentora e anexo de perfil pela conta. Segredos só em memória. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import type {Page,Request} from 'playwright';
import {startUi,type Ui} from './ui-harness';

let ui:Ui;
// Next dev compila cada rota no primeiro acesso (~30 s nesta máquina): aquece antes dos testes para que o timeout de navegação meça a UI.
before(async()=>{ui=await startUi('ui-registration');for(const route of ['/inscricao','/mentora','/login','/troca-senha'])await fetch(ui.origin+route);},{timeout:420_000});
after(async()=>{await ui?.stop();});

const unique=(label:string)=>`ui-${label}-${randomBytes(4).toString('hex')}@example.invalid`;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const main=(page:Page)=>page.getByRole('main');
/** Alerta da tela (o Next injeta seu próprio route-announcer com role=alert fora do main). */
const alertText=async(page:Page,expected:RegExp)=>{const a=main(page).getByRole('alert').filter({hasText:expected});await a.waitFor();return (await a.innerText()).trim();};
const focused=(page:Page)=>page.evaluate(()=>{const el=document.activeElement as HTMLInputElement|null;return {id:el?.id??'',name:el?.getAttribute('name')??'',type:el?.getAttribute('type')??''};});
const body=(request:Request)=>request.postDataJSON() as Record<string,unknown>;
const NO_PROMISE=/enviamos|foi enviad|entregue|chegou|verifique sua caixa|protocolo|token/i;

/** Etapa 1 do diagnóstico: objetivo e momento. */
async function stepOne(page:Page){
 await page.getByRole('radio',{name:/Crescimento/}).check();
 // o rótulo estilizado cobre o radio: clica-se no texto visível, como a usuária
 await page.locator('.moment-options label',{hasText:'Em atividade'}).click();
 await page.getByRole('button',{name:/Continuar/}).click();
 await page.getByRole('group',{name:/O que faz parte da sua trajetória/}).waitFor();
}
/** Etapa 2 com três interesses, quatro habilidades e área conhecida. */
async function stepTwo(page:Page,email?:string){
 for(const t of ['Dados','Produto','Design'])await page.getByRole('group',{name:/O que faz parte/}).getByLabel(t,{exact:true}).check();
 for(const s of ['Comunicação','Análise','Programação','Gestão'])await page.getByRole('group',{name:/Quais habilidades/}).getByLabel(s,{exact:true}).check();
 await page.getByLabel('Sua área de atuação').selectOption('dados');
 if(email!==undefined)await page.getByLabel('Seu e-mail').fill(email);
 await page.getByRole('checkbox',{name:/Concordo/}).check();
}

test('inscrição pública: duas etapas, foco no primeiro inválido, até 4 habilidades, rede preserva escolhas e 202 neutro idêntico na duplicata',{timeout:300_000},async()=>{
 const email=unique('pub');
 const {page,context}=await ui.newPage();
 try{
  await page.goto(ui.origin+'/inscricao');
  // composição preservada: progresso de duas etapas, título e arte do Perfil 1
  await main(page).getByText('ETAPA 01 / 02').waitFor();
  await page.getByRole('heading',{name:/Seu próximo movimento começa aqui/}).waitFor();
  assert.ok(await page.locator('.thread-illustration picture img[src*="perfil-1"]').count()>0,'arte Perfil 1 preservada');
  // quem já tem conta entra explicitamente e volta para cá
  assert.equal(await main(page).getByRole('link',{name:/Já tenho conta/}).getAttribute('href'),'/login?next=%2Finscricao');
  // etapa 1: foco no primeiro inválido
  await page.getByRole('button',{name:/Continuar/}).click();
  await alertText(page,/objetivo/);
  assert.equal((await focused(page)).name,'goal');
  await page.getByRole('radio',{name:/Crescimento/}).check();
  await page.getByRole('button',{name:/Continuar/}).click();
  await alertText(page,/momento/);
  assert.equal((await focused(page)).name,'moment');
  assert.equal(await page.getByRole('radio',{name:/Crescimento/}).isChecked(),true,'escolha preservada após erro');
  await page.locator('.moment-options label',{hasText:'Em atividade'}).click();
  await page.getByRole('button',{name:/Continuar/}).click();
  await main(page).getByText('ETAPA 02 / 02').waitFor();
  // etapa 2 vazia: foco no primeiro interesse
  const submit=page.getByRole('button',{name:/Enviar inscrição/});
  await submit.click();
  await alertText(page,/interesse/);
  assert.equal((await focused(page)).name,'interest');
  // interesses: limite 3; habilidades: até 4
  const interests=page.getByRole('group',{name:/O que faz parte/});
  for(const t of ['Dados','Produto','Design','Desenvolvimento'])await interests.getByLabel(t,{exact:true}).click();
  assert.equal(await interests.getByRole('checkbox',{checked:true}).count(),3);
  assert.equal(await interests.getByLabel('Desenvolvimento',{exact:true}).isChecked(),false);
  await submit.click();
  await alertText(page,/habilidade/);
  assert.equal((await focused(page)).name,'skill');
  const skills=page.getByRole('group',{name:/Quais habilidades/});
  for(const s of ['Comunicação','Análise','Programação','Gestão'])await skills.getByLabel(s,{exact:true}).click();
  assert.equal(await skills.getByRole('checkbox',{checked:true}).count(),4,'quatro habilidades aceitas');
  // área "outra" exige o texto; depois volta para área conhecida
  await page.getByLabel('Sua área de atuação').selectOption('outra');
  await submit.click();
  await alertText(page,/área/);
  assert.equal((await focused(page)).id,'other-area');
  await page.getByLabel('Qual área?').fill('Biotecnologia');
  await page.getByLabel('Sua área de atuação').selectOption('dados');
  assert.equal(await page.getByLabel('Qual área?').count(),0);
  await page.getByLabel('Seu e-mail').fill('sem-arroba');
  await submit.click();
  await alertText(page,/e-mail/);
  assert.equal((await focused(page)).id,'email');
  await page.getByLabel('Seu e-mail').fill(email);
  await submit.click();
  await alertText(page,/consentimento/);
  assert.equal((await focused(page)).type,'checkbox');
  await page.getByRole('checkbox',{name:/Concordo/}).check();
  // falha de transporte (injeção só nesta tentativa): mensagem segura e nada se perde
  const keys:string[]=[];
  await page.route('**/api/v1/registrations/participants',async r=>{keys.push(r.request().headers()['idempotency-key']??'');await r.abort('internetdisconnected');});
  await submit.click();
  const offline=await alertText(page,/Sem conexão/);
  assert.doesNotMatch(offline,/TypeError|Failed to fetch|stack/i);
  assert.equal(await interests.getByRole('checkbox',{checked:true}).count(),3);
  assert.equal(await skills.getByRole('checkbox',{checked:true}).count(),4);
  assert.equal(await page.getByLabel('Seu e-mail').inputValue(),email);
  assert.equal(await page.getByLabel('Sua área de atuação').inputValue(),'dados');
  await page.unroute('**/api/v1/registrations/participants');
  // reenvio real (PG): mesma chave de idempotência, DTO fechado sem otherArea
  const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/registrations/participants')),submit.click()]);
  assert.equal(response.status(),202);
  const sent=body(response.request());
  assert.deepEqual(Object.keys(sent).sort(),['area','consent','email','goal','interests','moment','skills']);
  assert.deepEqual(sent,{email,goal:'growth',moment:'working',interests:['dados','produto','design'],skills:['comunicacao','analise','codigo','gestao'],area:'dados',consent:true});
  const key=response.request().headers()['idempotency-key']??'';
  assert.match(key,UUID);assert.deepEqual(keys,[key],'reenvio após falha de rede reutiliza a chave');
  assert.deepEqual(((await response.json()) as {data:Record<string,unknown>}).data,{status:'received',next:'check_email'});
  const status=main(page).getByRole('status').filter({hasText:/Inscrição recebida/});await status.waitFor();
  const first=(await status.innerText()).trim();
  assert.equal(first.includes(email),false,'não ecoa o e-mail');
  assert.match(first,/não confirma envio nem entrega/);assert.match(first,/NÃO ENVIADA/);
  assert.doesNotMatch(first,NO_PROMISE);
  // /conta é o destino padrão do login (DEFAULT_AFTER_LOGIN): o link não precisa de ?next; ui-auth prova login → /conta
  assert.equal(await main(page).getByRole('link',{name:/Entrar na conta/}).getAttribute('href'),'/login');
  const row=await ui.db.query<{skills:string[];area:string}>('select p.skills,p.area from participant p join app_user u on u.id=p.user_id where u.email=$1',[email]);
  assert.deepEqual(row.rows,[{skills:['comunicacao','analise','codigo','gestao'],area:'dados'}]);
  // duplicata: mesma resposta visual, nenhuma conta nova
  const again=await ui.newPage();
  try{
   await again.page.goto(ui.origin+'/inscricao');await stepOne(again.page);await stepTwo(again.page,email);
   const [dup]=await Promise.all([again.page.waitForResponse(r=>r.url().endsWith('/api/v1/registrations/participants')),again.page.getByRole('button',{name:/Enviar inscrição/}).click()]);
   assert.equal(dup.status(),202);
   const second=main(again.page).getByRole('status').filter({hasText:/Inscrição recebida/});await second.waitFor();
   assert.equal((await second.innerText()).trim(),first,'duplicata indistinguível');
  }finally{await again.context.close();}
  assert.equal((await ui.db.query('select 1 from app_user where email_key=lower($1)',[email])).rowCount,1);
  const mail=await ui.drain();
  for(const m of mail)assert.equal((await page.content()).includes(m.secret),false);
  ui.assertNoLeak();
 }finally{await context.close();}
});

/** Perfil de mentora completo (e-mail só no cadastro público). */
async function mentorFields(page:Page,name:string,email?:string){
 await page.getByLabel('Nome de exibição').fill(name);
 if(email!==undefined)await page.getByLabel('Seu e-mail').fill(email);
 await page.getByLabel('Trajetória').fill('Dez anos entre dados e produto em Recife.');
 await page.getByRole('group',{name:/Em quais áreas/}).getByLabel('Dados',{exact:true}).click();
 await page.getByLabel('Disponibilidade descritiva').fill('Encontros presenciais no dia do evento.');
 await page.getByLabel(/Capacidade legada/).fill('2');
 await page.getByRole('checkbox',{name:/Concordo/}).check();
}

test('mentora pública: nome de exibição obrigatório, capacidade legada, foco no inválido e 202 neutro sem protocolo nem turma',{timeout:300_000},async()=>{
 const email=unique('mentor');const name=`Ana Recife ${randomBytes(2).toString('hex')}`;
 const {page,context}=await ui.newPage();
 try{
  await page.goto(ui.origin+'/mentora');
  await page.getByRole('heading',{name:/O que você aprendeu pode abrir um caminho/}).waitFor();
  assert.ok(await page.locator('.mentor-art picture img[src*="perfil-1"]').count()>0,'arte Perfil 1 preservada');
  const display=page.getByLabel('Nome de exibição');await display.waitFor();
  assert.deepEqual([await display.getAttribute('maxlength'),await display.getAttribute('required')],['120','']);
  assert.equal(await main(page).getByRole('link',{name:/Já tenho conta/}).getAttribute('href'),'/login?next=%2Fmentora');
  // capacidade é LEGADA: não define vagas de turma
  const capacity=page.getByLabel(/Capacidade legada/);
  assert.deepEqual([await capacity.getAttribute('min'),await capacity.getAttribute('max')],['1','50']);
  assert.match(await main(page).locator('#capacity-hint').innerText(),/não define vagas de turma/);
  const submit=page.getByRole('button',{name:/Cadastrar perfil/});
  await submit.click();
  await alertText(page,/nome de exibição/);
  assert.equal((await focused(page)).id,'mentor-name');
  await page.getByLabel('Nome de exibição').fill(name);await page.getByLabel('Seu e-mail').fill(email);
  await page.getByLabel('Trajetória').fill('Dez anos entre dados e produto em Recife.');
  await submit.click();
  await alertText(page,/especialidade/);
  assert.equal((await focused(page)).name,'specialties');
  assert.equal(await page.getByLabel('Nome de exibição').inputValue(),name,'campos preservados');
  await mentorFields(page,name,email);
  await page.getByLabel(/Capacidade legada/).fill('51');
  await submit.click();
  await alertText(page,/capacidade/i);
  assert.equal((await focused(page)).id,'capacity');
  await page.getByLabel(/Capacidade legada/).fill('2');
  const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/registrations/mentors')),submit.click()]);
  assert.equal(response.status(),202);
  assert.deepEqual(body(response.request()),{email,displayName:name,trajectory:'Dez anos entre dados e produto em Recife.',specialties:['dados'],availability:'Encontros presenciais no dia do evento.',legacyCapacity:2,consent:true});
  assert.match(response.request().headers()['idempotency-key']??'',UUID);
  const status=main(page).getByRole('status').filter({hasText:/Cadastro recebido/});await status.waitFor();
  const text=(await status.innerText()).trim();
  assert.equal(text.includes(email),false);
  assert.match(text,/não confirma envio nem entrega/);assert.match(text,/não cria turmas/);
  assert.doesNotMatch(text,NO_PROMISE);assert.doesNotMatch(text,/revis|aprova/i);
  assert.doesNotMatch(await main(page).innerText(),/Agendar|agenda automática/i);
  // /conta é o destino padrão do login (DEFAULT_AFTER_LOGIN): o link não precisa de ?next; ui-auth prova login → /conta
  assert.equal(await main(page).getByRole('link',{name:/Entrar na conta/}).getAttribute('href'),'/login');
  const row=await ui.db.query<{display_name:string;capacity:number}>('select m.display_name,m.capacity from mentor m join app_user u on u.id=m.user_id where u.email=$1',[email]);
  assert.deepEqual(row.rows,[{display_name:name,capacity:2}]);
  for(const m of await ui.drain())assert.equal((await page.content()).includes(m.secret),false);
  ui.assertNoLeak();
 }finally{await context.close();}
});

test('prazo da mentora: falha de rede não finge encerramento e permite tentar de novo; prazo encerrado publicado é outro estado',{timeout:240_000},async()=>{
 const {page,context}=await ui.newPage();
 try{
  // falha de transporte (injeção só nesta tela de teste): erro honesto com retry, nunca "encerrado"
  await page.route('**/api/mentor',r=>r.abort('internetdisconnected'));
  await page.goto(ui.origin+'/mentora');
  const text=await alertText(page,/Não foi possível verificar o prazo/);
  assert.doesNotMatch(text,/TypeError|Failed to fetch|stack/i);
  assert.doesNotMatch(await main(page).innerText(),/encerrad/i);
  assert.equal(await page.getByLabel('Nome de exibição').count(),0,'sem prazo confirmado não mostra formulário');
  // volta a rede: retry real consulta o prazo publicado (aberto) e libera o formulário
  await page.unroute('**/api/mentor');
  const [real]=await Promise.all([page.waitForResponse(r=>new URL(r.url()).pathname==='/api/mentor'),page.getByRole('button',{name:/Tentar novamente/}).click()]);
  assert.equal(real.status(),200);assert.equal(((await real.json()) as {open:boolean}).open,true);
  await page.getByLabel('Nome de exibição').waitFor();
  assert.equal(await main(page).getByRole('alert').count(),0);
  // resposta de prazo encerrado (publicada pelo servidor; simulada só aqui): estado próprio, sem retry nem formulário
  const closed=await ui.newPage();
  try{
   await closed.page.route('**/api/mentor',r=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify({open:false,deadline:'2026-10-31T02:59:59.999Z'})}));
   await closed.page.goto(ui.origin+'/mentora');
   await main(closed.page).getByRole('status').filter({hasText:/Cadastro encerrado/}).waitFor();
   assert.equal(await closed.page.getByRole('button',{name:/Tentar novamente/}).count(),0);
   assert.equal(await closed.page.getByLabel('Nome de exibição').count(),0);
   assert.doesNotMatch(await main(closed.page).innerText(),/Não foi possível verificar/);
  }finally{await closed.context.close();}
  // resposta fora do contrato também é erro com retry, não encerramento
  await page.route('**/api/mentor',r=>r.fulfill({status:503,contentType:'text/html',body:'<h1>indisponível</h1>'}));
  await page.reload();
  await alertText(page,/Não foi possível verificar o prazo/);
  assert.doesNotMatch(await main(page).innerText(),/encerrad/i);
 }finally{await context.close();}
});

const strong=()=>`Recife-${randomBytes(12).toString('base64url')}`;
const roles=async(email:string)=>(await ui.db.query<{role:string}>('select r.role from user_role r join app_user u on u.id=r.user_id where u.email=$1 order by r.role',[email])).rows.map(r=>r.role);
const sessionRoles=(page:Page)=>page.evaluate(async()=>{const r=await fetch('/api/v1/auth/session',{cache:'no-store'});const b=(await r.json()) as {data?:{state:string;user?:{roles:string[]}}};return {state:b.data?.state??`http-${r.status}`,roles:[...(b.data?.user?.roles??[])].sort()};});
/** Conta de mentora pelo cadastro público real (202) + worker fake → senha temporária só em memória. */
async function mentorTemporaryPassword(email:string){
 const res=await fetch(ui.origin+'/api/v1/registrations/mentors',{method:'POST',headers:{'Content-Type':'application/json',Origin:ui.origin,'Sec-Fetch-Site':'same-origin','Idempotency-Key':randomUUID()},body:JSON.stringify({email,displayName:'Mentora Base',trajectory:'Trajetória base.',specialties:['design'],availability:'No evento.',legacyCapacity:1,consent:true})});
 assert.equal(res.status,202);
 const mail=(await ui.drain()).filter(m=>m.to.toLowerCase()===email.toLowerCase());assert.equal(mail.length,1);return mail[0].secret;
}
/** Entra com a temporária (sessão limitada) e define a definitiva pela UI. */
async function signInTemporary(page:Page,email:string,temp:string){
 await page.goto(ui.origin+'/login');
 await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();
 await page.waitForURL(u=>u.pathname==='/troca-senha');
}
async function definePassword(page:Page,temp:string){
 const definitive=strong();ui.secrets.add(definitive);
 await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(definitive);await page.getByLabel('Confirme a nova senha').fill(definitive);
 await page.getByRole('button',{name:/Salvar nova senha/}).click();
}
async function assertSignedInForm(page:Page,email:string){
 assert.equal(await page.getByLabel('Seu e-mail').count(),0,'conta autenticada: sem pedir e-mail');
 assert.equal(await page.locator('input[type=password]').count(),0,'sem senha nem nova conta');
 assert.equal(await main(page).getByRole('link',{name:/Já tenho conta/}).count(),0);
 assert.ok((await main(page).innerText()).includes(email),'mostra em qual conta o perfil entra');
}

test('conta ativa anexa perfil de mentora sem e-mail nem credencial nova; sessão limitada passa antes pela troca',{timeout:300_000},async()=>{
 const email=unique('multi');const temp=await ui.temporaryPassword(email);const name=`Bia Multi ${randomBytes(2).toString('hex')}`;
 const {page,context}=await ui.newPage();
 try{
  await signInTemporary(page,email,temp);
  // sessão limitada tentando anexar: conduzida à troca obrigatória, com volta ao cadastro
  for(const route of ['/mentora','/inscricao']){
   await page.goto(ui.origin+route);
   await page.waitForURL(u=>u.pathname==='/troca-senha');
   assert.equal(new URL(page.url()).searchParams.get('next'),route);
  }
  assert.equal((await sessionRoles(page)).state,'password_change_required');
  await page.goto(ui.origin+'/mentora');await page.waitForURL(u=>u.pathname==='/troca-senha');
  await definePassword(page,temp);
  await page.waitForURL(u=>u.pathname==='/mentora');
  await page.getByLabel('Nome de exibição').waitFor();
  await assertSignedInForm(page,email);
  await ui.drain();
  await mentorFields(page,name);
  const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/me/profiles/mentor')),page.getByRole('button',{name:/Adicionar perfil de mentora/}).click()]);
  assert.equal(response.status(),201);
  assert.deepEqual(body(response.request()),{displayName:name,trajectory:'Dez anos entre dados e produto em Recife.',specialties:['dados'],availability:'Encontros presenciais no dia do evento.',legacyCapacity:2,consent:true});
  assert.ok((response.request().headers()['x-csrf-token']??'').length>0,'mutação autenticada com CSRF');
  await main(page).getByRole('status').filter({hasText:/Perfil de mentora criado/}).waitFor();
  assert.equal(await main(page).getByRole('link',{name:/Ir para Sua conta/}).getAttribute('href'),'/conta');
  assert.doesNotMatch(await main(page).innerText(),/revis|aprova|Agendar/i);
  assert.deepEqual(await roles(email),['mentor','participant']);
  assert.deepEqual(await sessionRoles(page),{state:'authenticated',roles:['mentor','participant']});
  assert.equal((await ui.db.query('select 1 from app_user where email_key=lower($1)',[email])).rowCount,1,'mesma conta, nenhuma nova');
  assert.equal((await ui.drain()).filter(m=>m.to.toLowerCase()===email.toLowerCase()).length,0,'nenhuma credencial nova emitida');
  // perfis já existentes: sem formulário, caminho para a conta
  for(const [route,label] of [['/inscricao',/já tem perfil de participante/],['/mentora',/já tem perfil de mentora/]] as const){
   await page.goto(ui.origin+route);
   await main(page).getByRole('status').filter({hasText:label}).waitFor();
   assert.equal(await main(page).getByRole('link',{name:/Ir para Sua conta/}).getAttribute('href'),'/conta');
   assert.equal(await page.getByLabel('Seu e-mail').count(),0);
  }
  ui.assertNoLeak();
 }finally{await context.close();}
});

test('mentora ativa anexa diagnóstico de participante pelo mesmo DTO sem e-mail; conta administrativa recebe erro seguro e mantém o formulário',{timeout:300_000},async()=>{
 const email=unique('mentor2p');const temp=await mentorTemporaryPassword(email);
 const {page,context}=await ui.newPage();
 try{
  await signInTemporary(page,email,temp);
  await page.goto(ui.origin+'/inscricao');await page.waitForURL(u=>u.pathname==='/troca-senha');
  await definePassword(page,temp);
  await page.waitForURL(u=>u.pathname==='/inscricao');
  await stepOne(page);await stepTwo(page);
  await assertSignedInForm(page,email);
  const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/me/profiles/participant')),page.getByRole('button',{name:/Adicionar perfil de participante/}).click()]);
  assert.equal(response.status(),201);
  assert.deepEqual(body(response.request()),{goal:'growth',moment:'working',interests:['dados','produto','design'],skills:['comunicacao','analise','codigo','gestao'],area:'dados',consent:true});
  await main(page).getByRole('status').filter({hasText:/Perfil de participante criado/}).waitFor();
  const link=main(page).getByRole('link',{name:/Ir para Sua conta/});
  assert.equal(await link.getAttribute('href'),'/conta');
  assert.match(await main(page).innerText(),/escolher mentora e turma/);
  assert.deepEqual(await roles(email),['mentor','participant']);
  assert.equal((await ui.drain()).filter(m=>m.to.toLowerCase()===email.toLowerCase()).length,0);
 }finally{await context.close();}
 // conta administrativa: o backend recusa anexar pelo fluxo comum (404); a tela não revela o motivo
 const admin=unique('admin');const adminTemp=await ui.temporaryPassword(admin);
 const other=await ui.newPage();
 try{
  await signInTemporary(other.page,admin,adminTemp);
  await other.page.goto(ui.origin+'/mentora');await other.page.waitForURL(u=>u.pathname==='/troca-senha');
  await definePassword(other.page,adminTemp);
  await other.page.waitForURL(u=>u.pathname==='/mentora');
  await ui.db.query("insert into user_role(user_id,role) select id,'admin' from app_user where email=$1",[admin]);
  await other.page.reload();
  await other.page.getByLabel('Nome de exibição').waitFor();
  const name='Admin Tentativa';
  await mentorFields(other.page,name);
  const [denied]=await Promise.all([other.page.waitForResponse(r=>r.url().endsWith('/api/v1/me/profiles/mentor')),other.page.getByRole('button',{name:/Adicionar perfil de mentora/}).click()]);
  assert.equal(denied.status(),404);
  const text=await alertText(other.page,/não pode receber este perfil/);
  assert.doesNotMatch(text,/admin|404|NOT_FOUND|Não encontramos|stack/i);
  assert.equal(await other.page.getByLabel('Nome de exibição').inputValue(),name,'campos preservados');
  assert.equal((await ui.db.query('select 1 from mentor m join app_user u on u.id=m.user_id where u.email=$1',[admin])).rowCount,0);
  ui.assertNoLeak();
 }finally{await other.context.close();}
});
