/** UI real (Chromium + Next dev + PG16): diagnóstico/cadastro público 202 neutro, cadastro de mentora e anexo de perfil pela conta. Segredos só em memória. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
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
  assert.equal(await main(page).getByRole('link',{name:/Entrar na conta/}).getAttribute('href'),'/login?next=%2Fconta');
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
