/** UI real (Chromium + Next dev + PG16): login, sessão limitada → troca, logout, recuperação e reset. Segredos só em memória. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
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

test('esqueci a senha: 202 neutro idêntico para conta existente e inexistente, sem prometer envio',{timeout:240_000},async()=>{
 const email=unique('forgot');await ui.temporaryPassword(email);
 const {page,context}=await ui.newPage();
 try{
  await page.goto(ui.origin+'/login');await page.getByRole('link',{name:/Esqueci minha senha/}).click();
  await page.waitForURL(u=>u.pathname==='/recuperar-senha');
  const texts:string[]=[];
  for(const addr of [email,unique('nobody')]){
   await page.goto(ui.origin+'/recuperar-senha');
   const input=page.getByLabel('E-mail');assert.equal(await input.getAttribute('autocomplete'),'email');
   await input.fill(addr);
   const [response]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/password/forgot')),page.getByRole('button',{name:/Solicitar redefinição/}).click()]);
   assert.equal(response.status(),202);
   const status=page.getByRole('main').getByRole('status').filter({hasText:/Solicitação recebida/});await status.waitFor();
   const text=(await status.innerText()).trim();texts.push(text);
   assert.equal(text.includes(addr),false,'mensagem não ecoa o e-mail');
   assert.match(text,/não confirma envio nem entrega/);assert.match(text,/NÃO ENVIADA/);
   assert.doesNotMatch(text,/enviamos|foi enviad|entregue|chegou|verifique sua caixa/i);
   assert.equal(await page.getByRole('link',{name:/Já tenho um código/}).getAttribute('href'),'/redefinir-senha');
  }
  assert.equal(texts[0],texts[1],'resposta visual idêntica: não revela existência de conta');
  const mail=await ui.drain();assert.ok(mail.every(m=>m.to.toLowerCase()===email.toLowerCase()),'só a conta existente gera job');
  assert.ok(mail.length<=1);
  for(const m of mail)assert.equal((await page.content()).includes(m.secret),false);
  ui.assertNoLeak();
 }finally{await context.close();}
});

test('reset: token de link (query ou #) some da URL/DOM, inválido é recusado sem exposição; link e código válidos 204 → login',{timeout:240_000},async()=>{
 const email=unique('reset');const temp=await ui.temporaryPassword(email);const first=strong();ui.secrets.add(first);
 const {page,context,console:lines}=await ui.newPage();
 try{
  // ativa a conta pela UI (temporária → definitiva)
  await page.goto(ui.origin+'/login');await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();
  await page.waitForURL(u=>u.pathname==='/troca-senha');
  await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(first);await page.getByLabel('Confirme a nova senha').fill(first);
  await page.getByRole('button',{name:/Salvar nova senha/}).click();await page.getByRole('heading',{name:/Sua conta/}).waitFor();
  await context.clearCookies();
  // token inválido na query: removido da barra de endereço e nunca renderizado
  const bogus=randomBytes(32).toString('base64url');
  await page.goto(ui.origin+'/redefinir-senha?token='+bogus);
  await page.getByRole('heading',{name:/Redefinir senha/}).waitFor();
  await page.waitForFunction(()=>!location.search.includes('token'));
  assert.equal(page.url(),ui.origin+'/redefinir-senha');
  assert.equal(await page.getByLabel('Código de redefinição').count(),0,'código veio do link: sem campo com o valor');
  assert.equal((await page.content()).includes(bogus),false);
  const next=strong();ui.secrets.add(next);
  const fresh=page.getByLabel('Nova senha',{exact:true});assert.deepEqual([await fresh.getAttribute('minlength'),await fresh.getAttribute('maxlength'),await fresh.getAttribute('autocomplete')],['12','128','new-password']);
  await fresh.fill(next);await page.getByLabel('Confirme a nova senha').fill(next);
  const [bad]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/password/reset')),page.getByRole('button',{name:/Redefinir senha/}).click()]);
  assert.equal(bad.status(),400);
  await alertText(page,/inválido, já foi usado ou venceu/);
  assert.equal(await page.getByRole('main').getByRole('link',{name:/Solicitar novo código/}).getAttribute('href'),'/recuperar-senha');
  assert.equal((await page.content()).includes(bogus),false);
  const requestReset=async()=>{
   const forgot=await fetch(ui.origin+'/api/v1/auth/password/forgot',{method:'POST',headers:{'Content-Type':'application/json',Origin:ui.origin,'Sec-Fetch-Site':'same-origin'},body:JSON.stringify({email})});
   assert.equal(forgot.status,202);
   const mail=(await ui.drain()).filter(m=>m.kind==='password_reset'&&m.to.toLowerCase()===email.toLowerCase());assert.equal(mail.length,1);return mail[0].secret;
  };
  const submitReset=async()=>{
   const [done]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/password/reset')),page.getByRole('button',{name:/Redefinir senha/}).click()]);
   assert.equal(done.status(),204);
   await page.waitForURL(u=>u.pathname==='/login');
   await page.getByRole('main').getByRole('status').filter({hasText:/Senha redefinida/}).waitFor();
  };
  // link com fragmento (formato recomendado): o token nunca vai ao servidor, sai da URL e do DOM
  const linked=await requestReset();const middle=strong();ui.secrets.add(middle);
  await page.goto(ui.origin+'/redefinir-senha#token='+linked);
  await page.getByRole('heading',{name:/Redefinir senha/}).waitFor();
  await page.waitForFunction(()=>!location.hash.includes('token'));
  assert.equal(page.url(),ui.origin+'/redefinir-senha');
  assert.equal(await page.getByLabel('Código de redefinição').count(),0);
  assert.equal((await page.content()).includes(linked),false);
  await page.getByLabel('Nova senha',{exact:true}).fill(middle);await page.getByLabel('Confirme a nova senha').fill(middle);
  await submitReset();
  assert.equal((await page.content()).includes(linked),false);
  // código real (fake em memória) digitado manualmente → 204 → login com a nova senha
  const code=await requestReset();
  await page.goto(ui.origin+'/redefinir-senha');
  const codeField=page.getByLabel('Código de redefinição');assert.equal(await codeField.getAttribute('autocomplete'),'one-time-code');
  await codeField.fill(code);await page.getByLabel('Nova senha',{exact:true}).fill(next);await page.getByLabel('Confirme a nova senha').fill(next);
  await submitReset();
  assert.equal((await page.content()).includes(code),false);
  for(const old of [first,middle]){
   await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(old);
   const [denied]=await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/v1/auth/login')),page.getByRole('button',{name:'Entrar',exact:true}).click()]);
   assert.equal(denied.status(),401);await alertText(page,/E-mail ou senha não conferem/);
  }
  await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(next);await page.getByRole('button',{name:'Entrar',exact:true}).click();
  await page.getByRole('heading',{name:/Sua conta/}).waitFor();assert.equal(await sessionState(page),'authenticated');
  assert.equal(lines.some(l=>l.includes(bogus)||l.includes(code)||l.includes(linked)),false);
  // Tokens de fragmento e digitados não aparecem em log algum. O de ?token= viaja na linha da requisição HTTP,
  // que o servidor Next dev registra (config de logging fora do WP-004): por isso o link recomendado usa #token=.
  ui.assertNoLeak();
  assert.equal(readFileSync(ui.appLog,'utf8').includes(linked),false,'token de fragmento nunca chega ao servidor');
 }finally{await context.close();}
});
