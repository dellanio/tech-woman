/** UI real (Chromium + Next dev + PG16): login, sessão limitada → troca, logout, recuperação e reset. Segredos só em memória. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import type {Page} from 'playwright';
import {startUi,type Ui} from './ui-harness';

let ui:Ui;
before(async()=>{ui=await startUi('ui-auth');},{timeout:300_000});
after(async()=>{await ui?.stop();});

const unique=(label:string)=>`ui-${label}-${randomBytes(4).toString('hex')}@example.invalid`;
const strong=()=>`Recife-${randomBytes(12).toString('base64url')}`;
const sessionState=(page:Page)=>page.evaluate(async()=>{const r=await fetch('/api/v1/auth/session',{cache:'no-store'});return r.status===200?((await r.json()) as {data:{state:string}}).data.state:`http-${r.status}`;});
const path=(page:Page)=>new URL(page.url()).pathname;
/** Alerta da tela (o Next injeta seu próprio route-announcer com role=alert fora do main). */
const alertText=async(page:Page,expected:RegExp)=>{const a=page.getByRole('main').getByRole('alert').filter({hasText:expected});await a.waitFor();return (await a.innerText()).trim();};

test('login: erro genérico; temporária → sessão limitada → troca obrigatória → sessão full',{timeout:240_000},async()=>{
 const email=unique('login');const temp=await ui.temporaryPassword(email);
 const {page,context}=await ui.newPage();
 try{
  await page.goto(ui.origin+'/login');
  const emailInput=page.getByLabel('E-mail');const password=page.getByLabel('Senha',{exact:true});
  assert.equal(await emailInput.getAttribute('autocomplete'),'email');
  assert.equal(await password.getAttribute('autocomplete'),'current-password');
  assert.equal(await password.getAttribute('type'),'password');
  assert.equal(await page.getByRole('link',{name:/Esqueci minha senha/}).getAttribute('href'),'/recuperar-senha');
  assert.equal(await page.getByRole('main').getByRole('link',{name:/Quero participar/}).getAttribute('href'),'/inscricao');
  // credencial errada e conta inexistente: mesma mensagem genérica, sem detalhe técnico
  const messages:string[]=[];
  for(const [addr,pw] of [[email,'senha-errada-123'],[unique('ghost'),'senha-errada-123']]){
   await emailInput.fill(addr);await password.fill(pw);
   const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/login')),page.getByRole('button',{name:'Entrar',exact:true}).click()]);
   assert.equal(response.status(),401);messages.push(await alertText(page,/conferem/));
  }
  assert.equal(messages[0],messages[1]);assert.match(messages[0],/E-mail ou senha não conferem/);
  assert.doesNotMatch(messages[0],/INVALID_CREDENTIALS|401|error|stack/i);
  assert.equal(await sessionState(page),'http-401');
  // temporária: só sessão limitada, sempre levada à troca
  await emailInput.fill(email);await password.fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();
  await page.waitForURL(u=>u.pathname==='/troca-senha');
  assert.equal(await sessionState(page),'password_change_required');
  await page.getByRole('heading',{name:/Defina sua senha/}).waitFor();
  const current=page.getByLabel('Senha atual ou temporária');const fresh=page.getByLabel('Nova senha',{exact:true});const confirm=page.getByLabel('Confirme a nova senha');
  assert.equal(await current.getAttribute('autocomplete'),'current-password');
  assert.equal(await fresh.getAttribute('autocomplete'),'new-password');
  assert.deepEqual([await fresh.getAttribute('minlength'),await fresh.getAttribute('maxlength')],['12','128']);
  const save=page.getByRole('button',{name:/Salvar nova senha/});
  await current.fill(temp);await fresh.fill('curta');await confirm.fill('curta');await save.click();
  await alertText(page,/12 a 128/);
  assert.equal(await sessionState(page),'password_change_required','validação local não chama a API');
  const definitive=strong();ui.secrets.add(definitive);
  await fresh.fill(definitive);await confirm.fill(definitive+'x');await save.click();
  await alertText(page,/não coincidem/);
  await current.fill('senha-errada-123');await confirm.fill(definitive);await save.click();
  await alertText(page,/Senha atual ou temporária não confere/);
  assert.equal(await sessionState(page),'password_change_required');
  await current.fill(temp);await save.click();
  await page.waitForURL(u=>u.pathname==='/login');
  await page.getByRole('heading',{name:/Sua conta/}).waitFor();
  assert.ok((await page.getByRole('main').innerText()).includes(email));
  assert.equal(await sessionState(page),'authenticated');
  const html=await page.content();assert.equal(html.includes(temp),false);assert.equal(html.includes(definitive),false);
  ui.assertNoLeak();
 }finally{await context.close();}
});

test('sessão limitada sempre volta à troca; destino só local; logout 204 encerra a sessão',{timeout:240_000},async()=>{
 const email=unique('limited');const temp=await ui.temporaryPassword(email);
 const {page,context}=await ui.newPage();
 const signIn=async(pw:string)=>{await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(pw);await page.getByRole('button',{name:'Entrar',exact:true}).click();};
 try{
  await page.goto(ui.origin+'/login?next=%2Finscricao');await signIn(temp);
  await page.waitForURL(u=>u.pathname==='/troca-senha');assert.equal(new URL(page.url()).searchParams.get('next'),'/inscricao');
  // limitada tentando abrir área autenticada: volta para a troca, nunca vê painel de conta
  await page.goto(ui.origin+'/login?next=%2Fadmin');
  await page.waitForURL(u=>u.pathname==='/troca-senha');assert.equal(new URL(page.url()).searchParams.get('next'),'/admin');
  assert.equal(await page.getByRole('heading',{name:/Sua conta/}).count(),0);
  assert.equal(await sessionState(page),'password_change_required');
  // destino externo descartado
  const definitive=strong();ui.secrets.add(definitive);
  await page.goto(ui.origin+'/troca-senha?next='+encodeURIComponent('//evil.example/roubo'));
  await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(definitive);await page.getByLabel('Confirme a nova senha').fill(definitive);
  await page.getByRole('button',{name:/Salvar nova senha/}).click();
  await page.waitForURL(u=>u.pathname==='/login');assert.equal(new URL(page.url()).origin,ui.origin);
  await page.getByRole('main').getByRole('status').filter({hasText:/Senha definida/}).waitFor();
  // logout: 204 sem corpo, sessão encerrada e formulário de volta
  const [logout]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/logout')),page.getByRole('button',{name:/Sair/}).click()]);
  assert.equal(logout.status(),204);
  await page.getByRole('main').getByRole('status').filter({hasText:/Você saiu/}).waitFor();
  await page.getByRole('button',{name:'Entrar',exact:true}).waitFor();
  assert.equal(await sessionState(page),'http-401');
  // login full com destino local permitido; destino externo cai no padrão
  await page.goto(ui.origin+'/login?next=%2Finscricao');await signIn(definitive);
  await page.waitForURL(u=>u.pathname==='/inscricao');
  for(const evil of ['https://evil.example/x','//evil.example','/\\evil.example','/api/v1/auth/session']){
   await page.goto(ui.origin+'/login?next='+encodeURIComponent(evil));
   await page.getByRole('heading',{name:/Sua conta/}).waitFor();
   assert.equal(new URL(page.url()).origin,ui.origin);assert.equal(path(page),'/login');
  }
  ui.assertNoLeak();
 }finally{await context.close();}
});
