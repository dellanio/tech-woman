/** UI real (Chromium + Next dev + PG16): diagnóstico → crossing → e-mail + senha definitiva (202 neutro), cadastro de mentora e anexo de perfil pela conta. Segredos só em memória. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import type {Page,Request} from 'playwright';
import {startUi,type Ui} from './ui-harness';

let ui:Ui;
// Next dev compila cada rota no primeiro acesso (~30 s nesta máquina): aquece antes dos testes para que o timeout de navegação meça a UI.
before(async()=>{ui=await startUi('ui-registration');mkdirSync(`${ui.evidence}/screenshots`,{recursive:true});for(const route of ['/inscricao','/mentora','/login','/troca-senha'])await fetch(ui.origin+route);},{timeout:420_000});
after(async()=>{await ui?.stop();});

const unique=(label:string)=>`ui-${label}-${randomBytes(4).toString('hex')}@example.invalid`;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const main=(page:Page)=>page.getByRole('main');
/** Alerta da tela (o Next injeta seu próprio route-announcer com role=alert fora do main). */
const alertText=async(page:Page,expected:RegExp)=>{const a=main(page).getByRole('alert').filter({hasText:expected});await a.waitFor();return (await a.innerText()).trim();};
/** O formulário move o foco no próximo animation frame; aguarda a condição real, sem reduzir a asserção. */
const focused=async(page:Page,expected:Partial<{id:string;name:string;type:string}>)=>{
 await page.waitForFunction(wanted=>{const el=document.activeElement as HTMLInputElement|null;const current={id:el?.id??'',name:el?.getAttribute('name')??'',type:el?.getAttribute('type')??''};return Object.entries(wanted).every(([key,value])=>current[key as keyof typeof current]===value);},expected);
 return page.evaluate(()=>{const el=document.activeElement as HTMLInputElement|null;return {id:el?.id??'',name:el?.getAttribute('name')??'',type:el?.getAttribute('type')??''};});
};
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
/** Etapa 2 com três interesses, quatro habilidades e área conhecida. Consentimento só no anexo de perfil da conta autenticada. */
async function stepTwo(page:Page,o:{consent?:boolean}={}){
 for(const t of ['Dados','Produto','Design'])await page.getByRole('group',{name:/O que faz parte/}).getByLabel(t,{exact:true}).check();
 for(const s of ['Comunicação','Análise','Programação','Gestão'])await page.getByRole('group',{name:/Quais habilidades/}).getByLabel(s,{exact:true}).check();
 await page.getByLabel('Sua área de atuação').selectOption('dados');
 if(o.consent??true)await page.getByRole('checkbox',{name:/Concordo/}).check();
}
const FINAL='O cadastro da participante na plataforma criará o seu cadastro no sistema, além de já dar carga no cruzamento escolhido por ela.';
const shots=(name:string)=>`${ui.evidence}/screenshots/${name}.png`;
type Choice={mentor_ref:string;nome_exibicao:string};
/** Mentoras determinísticas do diagnóstico da etapa 2 (ranking legado): Ana 15, Bia 6, sem nome 3; inativa fora. Sem turmas. */
async function crossingMentors(){
 const add=(email:string,specialties:string[],name:string|null,active=true)=>ui.db.query("insert into mentor(email,trajectory,specialties,availability,capacity,active,display_name) values($1,'t',$2,'a',2,$3,$4)",[email,JSON.stringify(specialties),active,name]);
 await add('ui-ana@example.invalid',['dados','produto'],'Ana Recife');await add('ui-bia@example.invalid',['produto'],'Bia Produto');
 await add('ui-real@example.invalid',['design'],null);await add('ui-off@example.invalid',['dados'],'Mentora Inativa',false);
}
const radios=async(page:Page)=>main(page).getByRole('radiogroup',{name:/Escolha sua mentora/}).getByRole('radio').evaluateAll(els=>els.map(e=>(e.closest('label')?.querySelector('strong')?.textContent??'').trim()));
const isPreview=(url:string)=>new URL(url).pathname==='/api/v1/registrations/participants/preview';
const isSignup=(url:string)=>new URL(url).pathname==='/api/v1/registrations/participants';
/** Mesma referência em route/unroute (o Playwright remove a rota por identidade da função). */
const signupUrl=(u:URL)=>isSignup(u.toString()),previewUrl=(u:URL)=>isPreview(u.toString());

test('inscrição pública: diagnóstico → crossing (só nomes, troca) → e-mail + senha definitiva + confirmação → conclusão; login full sem troca',{timeout:300_000},async()=>{
 await crossingMentors();
 const email=unique('pub');const password=`Recife-${randomBytes(12).toString('base64url')}`;ui.secrets.add(password);
 const {page,context}=await ui.newPage();
 try{
  await page.goto(ui.origin+'/inscricao');
  await main(page).getByText('ETAPA 01 / 04').waitFor();
  await page.getByRole('heading',{name:/Seu próximo movimento começa aqui/}).waitFor();
  assert.ok(await page.locator('.thread-illustration picture img[src*="perfil-1"]').count()>0,'arte Perfil 1 preservada');
  assert.equal(await main(page).getByRole('link',{name:/Já tenho conta/}).getAttribute('href'),'/login?next=%2Finscricao');
  await page.getByRole('button',{name:/Continuar/}).click();
  await alertText(page,/objetivo/);assert.equal((await focused(page,{name:'goal'})).name,'goal');
  await stepOne(page);
  await main(page).getByText('ETAPA 02 / 04').waitFor();
  assert.equal(await page.getByLabel('Seu e-mail').count(),0,'e-mail só na última etapa');assert.equal(await page.locator('input[type=password]').count(),0);
  const toCrossing=page.getByRole('button',{name:/Ver mentoras compatíveis/});
  await toCrossing.click();
  await alertText(page,/interesse/);assert.equal((await focused(page,{name:'interest'})).name,'interest');
  await stepTwo(page,{consent:false});
  await page.screenshot({path:shots('inscricao-02-interesses-desktop'),fullPage:true});
  const [previewResponse]=await Promise.all([page.waitForResponse(r=>isPreview(r.url())),toCrossing.click()]);
  assert.equal(previewResponse.status(),200);
  assert.deepEqual(Object.keys(body(previewResponse.request())).sort(),['area','goal','interests','moment','skills'],'preview sem e-mail, senha nem consentimento');
  const choices=((await previewResponse.json()) as {data:Choice[]}).data;
  await main(page).getByText('ETAPA 03 / 04').waitFor();
  await main(page).getByRole('radiogroup',{name:/Escolha sua mentora/}).waitFor();
  assert.deepEqual(await radios(page),['Ana Recife','Bia Produto','(MENTORA)'],'todas as compatíveis, na ordem do ranking; sem nome → (MENTORA)');
  assert.equal(await page.getByRole('radio',{name:'Ana Recife'}).isChecked(),true,'primeira do ranking pré-selecionada');
  const panel=await main(page).locator('form').innerText();
  assert.doesNotMatch(panel,/\d{1,2}:\d{2}|\d{1,2}h\b|vagas|turma|score|ponto/i,'só nomes: sem datas, horários, vagas ou pontuação');
  assert.match(panel,/Datas e horários/i);
  await page.screenshot({path:shots('inscricao-03-crossing-desktop'),fullPage:true});
  // troca de mentora, ida e volta
  await page.getByRole('radio',{name:'(MENTORA)'}).check();
  await page.getByRole('button',{name:/^Continuar/}).click();
  await main(page).getByText('ETAPA 04 / 04').waitFor();
  await main(page).getByText(/Mentora escolhida: \(MENTORA\)/).waitFor();
  await page.getByRole('button',{name:/Trocar mentora/}).click();
  await main(page).getByText('ETAPA 03 / 04').waitFor();
  assert.equal(await page.getByRole('radio',{name:'(MENTORA)'}).isChecked(),true,'escolha preservada ao voltar');
  await page.getByRole('radio',{name:'Bia Produto'}).check();
  await page.getByRole('button',{name:/^Continuar/}).click();
  await main(page).getByText(/Mentora escolhida: Bia Produto/).waitFor();
  // última etapa: e-mail, senha definitiva, confirmação e o texto final exato
  assert.equal(await main(page).getByText(FINAL,{exact:true}).count(),1,'texto final exato');
  const submit=page.getByRole('button',{name:/Concluir cadastro/});
  await submit.click();
  await alertText(page,/e-mail/);assert.equal((await focused(page,{id:'email'})).id,'email');
  await page.getByLabel('Seu e-mail').fill(email);
  await page.getByLabel('Senha definitiva',{exact:true}).fill('curta');
  await submit.click();
  await alertText(page,/12 a 128/);assert.equal((await focused(page,{id:'password'})).id,'password');
  await page.getByLabel('Senha definitiva',{exact:true}).fill(password);
  await page.getByLabel('Confirme a senha').fill(password+'x');
  await submit.click();
  await alertText(page,/não conferem/);assert.equal((await focused(page,{id:'password-confirmation'})).id,'password-confirmation');
  await page.getByLabel('Confirme a senha').fill(password);
  await submit.click();
  await alertText(page,/Confirme/);assert.equal((await focused(page,{type:'checkbox'})).type,'checkbox');
  await page.getByRole('checkbox',{name:FINAL}).check();
  await page.screenshot({path:shots('inscricao-04-acesso-desktop'),fullPage:true});
  // falha de transporte: nada se perde e o reenvio usa a mesma chave
  const keys:string[]=[];
  await page.route(signupUrl,async r=>{keys.push(r.request().headers()['idempotency-key']??'');await r.abort('internetdisconnected');});
  await submit.click();
  assert.doesNotMatch(await alertText(page,/Sem conexão/),/TypeError|Failed to fetch|stack/i);
  assert.equal(await page.getByLabel('Seu e-mail').inputValue(),email);
  await page.unroute(signupUrl);
  const [response]=await Promise.all([page.waitForResponse(r=>isSignup(r.url())),submit.click()]);
  assert.equal(response.status(),202);
  const sent=body(response.request());
  assert.deepEqual(Object.keys(sent).sort(),['area','consent','email','goal','interests','mentor_ref','moment','password','passwordConfirmation','skills']);
  assert.equal(sent.mentor_ref,choices.find(c=>c.nome_exibicao==='Bia Produto')?.mentor_ref,'mentora trocada é a enviada');
  const key=response.request().headers()['idempotency-key']??'';assert.match(key,UUID);assert.deepEqual(keys,[key]);
  assert.deepEqual(((await response.json()) as {data:Record<string,unknown>}).data,{status:'received',next:'login'});
  const status=main(page).getByRole('status').filter({hasText:/Cadastro concluído/});await status.waitFor();
  const first=(await status.innerText()).trim();
  assert.equal(first.includes(email),false,'não ecoa o e-mail');assert.doesNotMatch(first,/temporária|verifique sua caixa|enviamos/i);
  assert.equal(await main(page).getByRole('link',{name:/Entrar na conta/}).getAttribute('href'),'/login');
  await page.screenshot({path:shots('inscricao-05-concluido-desktop'),fullPage:true});
  const row=(await ui.db.query("select u.status,u.temporary_password_hash is null nt,m.display_name mentor,(select count(*)::int from email_job j where j.user_id=u.id) jobs from app_user u join participant p on p.user_id=u.id join match x on x.participant_id=p.id join mentor m on m.id=x.mentor_id where u.email=$1",[email])).rows;
  assert.deepEqual(row,[{status:'active',nt:true,mentor:'Bia Produto',jobs:0}]);
  // login com a senha definitiva: sessão full direto em Sua conta, sem troca obrigatória
  await main(page).getByRole('link',{name:/Entrar na conta/}).click();
  await page.waitForURL(u=>u.pathname==='/login');
  await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(password);await page.getByRole('button',{name:'Entrar',exact:true}).click();
  await page.waitForURL(u=>u.pathname==='/conta');
  assert.deepEqual(await sessionRoles(page),{state:'authenticated',roles:['participant']});
  // duplicata: mesma tela final, nenhuma conta nova
  const again=await ui.newPage();
  try{
   await again.page.goto(ui.origin+'/inscricao');await stepOne(again.page);await stepTwo(again.page,{consent:false});
   await again.page.getByRole('button',{name:/Ver mentoras compatíveis/}).click();
   await again.page.getByRole('radio',{name:'Ana Recife'}).waitFor();await again.page.getByRole('button',{name:/^Continuar/}).click();
   const other=`Recife-${randomBytes(12).toString('base64url')}`;ui.secrets.add(other);
   await again.page.getByLabel('Seu e-mail').fill(email);await again.page.getByLabel('Senha definitiva',{exact:true}).fill(other);await again.page.getByLabel('Confirme a senha').fill(other);
   await again.page.getByRole('checkbox',{name:FINAL}).check();
   const [dup]=await Promise.all([again.page.waitForResponse(r=>isSignup(r.url())),again.page.getByRole('button',{name:/Concluir cadastro/}).click()]);
   assert.equal(dup.status(),202);
   const second=main(again.page).getByRole('status').filter({hasText:/Cadastro concluído/});await second.waitFor();
   assert.equal((await second.innerText()).trim(),first,'duplicata indistinguível');
  }finally{await again.context.close();}
  assert.equal((await ui.db.query('select 1 from app_user where email_key=lower($1)',[email])).rowCount,1);
  assert.equal((await ui.drain()).length,0,'nenhum e-mail no caminho normal');
  assert.equal((await page.content()).includes(password),false);
  ui.assertNoLeak();
 }finally{await context.close();}
});

test('crossing: sem compatíveis explica e permite editar; resposta atrasada de preview antigo é ignorada; mobile',{timeout:300_000},async()=>{
 const {page,context}=await ui.newPage({viewport:{width:390,height:844}});
 try{
  await page.goto(ui.origin+'/inscricao');await stepOne(page);
  const group=(name:RegExp)=>page.getByRole('group',{name});
  await group(/O que faz parte/).getByLabel('Desenvolvimento',{exact:true}).check();
  await group(/Quais habilidades/).getByLabel('Programação',{exact:true}).check();
  await page.getByLabel('Sua área de atuação').selectOption('outra');await page.getByLabel('Qual área?').fill('Biotecnologia');
  await page.getByRole('button',{name:/Ver mentoras compatíveis/}).click();
  const empty=main(page).getByRole('status').filter({hasText:/Nenhuma mentora compatível/});await empty.waitFor();
  assert.match(await empty.innerText(),/editar suas respostas/i);assert.doesNotMatch(await empty.innerText(),/cadastro concluído|sucesso/i);
  assert.equal(await page.getByRole('radio').count(),0,'nenhum match inventado');
  assert.equal(await page.getByRole('button',{name:/^Continuar/}).count(),0,'não avança sem mentora');
  await page.screenshot({path:shots('inscricao-03-sem-compativeis-mobile'),fullPage:true});
  await main(page).getByRole('button',{name:/Editar respostas/}).first().click();
  await main(page).getByText('ETAPA 02 / 04').waitFor();
  assert.equal(await group(/O que faz parte/).getByLabel('Desenvolvimento',{exact:true}).isChecked(),true,'respostas preservadas');
  // corrida: o preview das respostas antigas responde DEPOIS do preview das respostas editadas e não pode sobrescrever a tela
  let calls=0;let releaseSlow:()=>void=()=>undefined;const slowGate=new Promise<void>(r=>{releaseSlow=r;});
  await page.route(previewUrl,async r=>{calls++;if(calls===1)await slowGate;try{await r.continue();}catch{/* requisição já abortada pela tela */}});
  // respostas mudam (área "outra" diferente, ainda sem compatíveis): o cruzamento é recalculado — e fica preso na rede
  await page.getByLabel('Qual área?').fill('Biotec');
  await page.getByRole('button',{name:/Ver mentoras compatíveis/}).click();
  await main(page).getByText(/Calculando/).waitFor();
  await main(page).getByRole('button',{name:/Editar respostas/}).first().click();
  await group(/O que faz parte/).getByLabel('Dados',{exact:true}).check();
  await page.getByRole('button',{name:/Ver mentoras compatíveis/}).click();
  await page.getByRole('radio',{name:'Ana Recife'}).waitFor();
  releaseSlow();await page.waitForTimeout(1500);
  assert.equal(calls,2);
  assert.equal(await page.getByRole('radio',{name:'Ana Recife'}).isChecked(),true,'resposta atrasada ignorada');
  assert.equal(await main(page).getByText(/Nenhuma mentora compatível/).count(),0);
  await page.unroute(previewUrl);
  await page.screenshot({path:shots('inscricao-03-crossing-mobile'),fullPage:true});
  await page.getByRole('button',{name:/^Continuar/}).click();
  await main(page).getByText(/Mentora escolhida: Ana Recife/).waitFor();
  await page.screenshot({path:shots('inscricao-04-acesso-mobile'),fullPage:true});
  const overflow=await page.evaluate(()=>document.documentElement.scrollWidth-document.documentElement.clientWidth);assert.ok(overflow<=1,`sem rolagem horizontal no mobile (${overflow})`);
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
  assert.equal((await focused(page,{id:'mentor-name'})).id,'mentor-name');
  await page.getByLabel('Nome de exibição').fill(name);await page.getByLabel('Seu e-mail').fill(email);
  await page.getByLabel('Trajetória').fill('Dez anos entre dados e produto em Recife.');
  await submit.click();
  await alertText(page,/especialidade/);
  assert.equal((await focused(page,{name:'specialties'})).name,'specialties');
  assert.equal(await page.getByLabel('Nome de exibição').inputValue(),name,'campos preservados');
  await mentorFields(page,name,email);
  await page.getByLabel(/Capacidade legada/).fill('51');
  await submit.click();
  await alertText(page,/capacidade/i);
  assert.equal((await focused(page,{id:'capacity'})).id,'capacity');
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
  // Prazo real no processo web próprio; conserva o mesmo PG sintético e todas as asserções.
  const closed=await ui.newPage();
  try{
   await ui.setMentorDeadline('2000-01-01T00:00:00.000Z');
   const response=closed.page.waitForResponse(r=>new URL(r.url()).pathname==='/api/mentor');
   await closed.page.goto(ui.origin+'/mentora');
   const published=await response;assert.equal(published.status(),200);assert.equal(((await published.json()) as {open:boolean}).open,false);
   await main(closed.page).getByRole('status').filter({hasText:/Cadastro encerrado/}).waitFor();
   assert.equal(await closed.page.getByRole('button',{name:/Tentar novamente/}).count(),0);
   assert.equal(await closed.page.getByLabel('Nome de exibição').count(),0);
   assert.doesNotMatch(await main(closed.page).innerText(),/Não foi possível verificar/);
  }finally{await closed.context.close();await ui.setMentorDeadline();}
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
