/** FIX-UI (GATE-002 achados 1–3): hierarquia operativa de Conta/Admin na primeira dobra 390×844, ordem DOM/teclado e tipografia de identificadores/títulos/pontos. Chromium + PG16 reais; nenhuma resposta HTTP simulada. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import type {Locator,Page} from 'playwright';
import {startUi,type Ui} from './ui-harness';

let ui:Ui;
const FOLD={width:390,height:844};
const records:Record<string,unknown>[]=[];
before(async()=>{ui=await startUi('fix-ui-hierarchy');await ui.db.query(readFileSync('scripts/migration/grants-local.sql','utf8'));for(const route of ['/admin','/login','/troca-senha','/conta'])await fetch(ui.origin+route);},{timeout:420_000});
after(async()=>{if(ui){mkdirSync(resolve(ui.evidence,'logs'),{recursive:true});writeFileSync(resolve(ui.evidence,'logs','fix-ui-hierarchy-positions.json'),JSON.stringify(records,null,2));}await ui?.stop();});

const main=(page:Page)=>page.getByRole('main');
const one=async(sql:string,params:unknown[])=>String((await ui.db.query<{id:string}>(sql,params)).rows[0].id);
/** Temporária → troca obrigatória → definitiva pela UI; termina em /conta. */
async function activate(page:Page,email:string,role?:'admin'){
 const temp=await ui.temporaryPassword(email);
 if(role)await ui.db.query('insert into user_role(user_id,role) select id,$2 from app_user where email=$1',[email,role]);
 await page.goto(ui.origin+'/login');await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL(u=>u.pathname==='/troca-senha');
 const secret='Recife-'+randomBytes(16).toString('hex');ui.secrets.add(secret);
 await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(secret);await page.getByLabel('Confirme a nova senha').fill(secret);await page.getByRole('button',{name:/Salvar nova senha/}).click();await page.waitForURL(u=>u.pathname==='/conta');
}
/** Mentora com especialidade "dados" e uma turma aberta: com o perfil do cadastro (dados/análise) pontua 3+3+2+1. */
async function mentorWithCohort(name:string){
 const mentor=await one("insert into mentor(email,trajectory,specialties,availability,capacity,active,display_name) values($1,'Trajetória sintética para a hierarquia.','[\"dados\"]','No evento.',2,true,$2) returning id",[`fixui-${randomBytes(4).toString('hex')}@example.invalid`,name]);
 const topic=await one("insert into topic(slug,name,active) values($1,'Dados — exemplo sintético',true) returning id",['fixui-'+randomBytes(4).toString('hex')]);
 const mt=await one('insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,1) returning id',[mentor,topic]);
 const start=new Date(Date.now()+30*86400e3);start.setUTCHours(12,0,0,0);
 await one("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,$2,$3,2,'open') returning id",[mt,start.toISOString(),new Date(start.getTime()+3600e3).toISOString()]);
}
/** Caixa na rolagem inicial (página no topo). */
async function box(locator:Locator){const b=await locator.boundingBox();assert.ok(b,'elemento renderizado');return b;}
const inFold=(b:{y:number;height:number})=>b.y>=0&&b.y+b.height<=FOLD.height;
async function noOverflow(page:Page){const o=await page.evaluate(()=>({viewport:innerWidth,scroll:document.documentElement.scrollWidth}));assert.ok(o.scroll<=o.viewport,`overflow horizontal ${o.scroll}/${o.viewport}`);}
/** Tab desde o topo até um dos alvos; devolve o índice do primeiro alcançado. */
async function firstByTab(page:Page,targets:Locator[]){
 await page.evaluate(()=>{(document.activeElement as HTMLElement|null)?.blur();window.scrollTo(0,0);});
 for(let i=0;i<60;i++){
  await page.keyboard.press('Tab');
  for(const [index,t] of targets.entries())if(await t.evaluate(e=>e===document.activeElement))return index;
 }
 assert.fail('nenhum alvo alcançado somente com Tab');
}

test('conta 390×844: escolha de mentora/turma vem antes de sessão e reservas (DOM, teclado e primeira dobra); passo seguinte recebe o foco',{timeout:300_000},async()=>{
 const name='Mentora Hierarquia';await mentorWithCohort(name);
 const {page,context}=await ui.newPage({viewport:FOLD});
 try{
  await context.addInitScript(()=>localStorage.setItem('tw-theme','dark'));
  await activate(page,`fixui-conta-${randomBytes(4).toString('hex')}-com-endereco-bem-longo@example.invalid`);
  await page.reload();await main(page).getByRole('heading',{name,exact:true}).waitFor();await page.waitForLoadState('networkidle');await page.evaluate(()=>document.fonts.ready);
  const journey=main(page).getByRole('region',{name:'Escolher mentora e turma'}),session=main(page).getByRole('region',{name:'Sua conta'}),bookings=main(page).getByRole('region',{name:'Suas reservas'});
  for(const r of [journey,session,bookings])assert.equal(await r.count(),1);
  // Ordem DOM (e portanto leitura/teclado): escolha antes da sessão e das reservas.
  const order=await page.evaluate(()=>{const j=document.getElementById('journey-title')!.closest('section')!;const [session,bookings]=['account-title','enrollments-title'].map(id=>!!(j.compareDocumentPosition(document.getElementById(id)!.closest('section')!)&Node.DOCUMENT_POSITION_FOLLOWING));return {session,bookings};});
  assert.deepEqual(order,{session:true,bookings:true},'escolha de mentora/turma precede sessão e reservas no DOM');
  // Primeira dobra: título da escolha, passo atual e a primeira mentora sugerida visíveis sem rolar.
  await page.evaluate(()=>window.scrollTo(0,0));
  const title=await box(main(page).getByRole('heading',{name:'Escolher mentora e turma',exact:true}));
  const step=await box(main(page).getByRole('heading',{name:'Escolha sua mentora',exact:true}));
  const mentor=await box(main(page).getByRole('heading',{name,exact:true}));
  const sessionTop=(await box(session)).y,bookingsTop=(await box(bookings)).y;
  records.push({name:'conta-390x844',journeyTitle:title,stepTitle:step,firstMentor:mentor,sessionTop,bookingsTop});
  assert.ok(inFold(title),`título da escolha na primeira dobra: ${JSON.stringify(title)}`);
  assert.ok(inFold(step),`passo atual na primeira dobra: ${JSON.stringify(step)}`);
  assert.ok(inFold(mentor),`primeira mentora na primeira dobra: ${JSON.stringify(mentor)}`);
  assert.ok(sessionTop>mentor.y&&bookingsTop>mentor.y,'sessão e reservas ficam depois da escolha');
  await noOverflow(page);
  // Teclado: a ação da mentora vem antes de “Trocar senha”; Enter avança e o foco vai ao título do novo passo.
  const action=main(page).getByRole('button',{name:`Ver temas e turmas de ${name}`}),password=main(page).getByRole('link',{name:'Trocar senha'});
  assert.equal(await firstByTab(page,[action,password]),0,'Tab alcança a escolha antes da sessão');
  await page.keyboard.press('Enter');
  const next=main(page).getByRole('heading',{name:'Escolha o tema e a turma',exact:true});await next.waitFor();
  await page.waitForFunction(()=>document.activeElement?.textContent==='Escolha o tema e a turma');
  assert.ok(await next.evaluate(e=>e===document.activeElement),'foco no título do passo seguinte');
  // Sessão e reservas continuam completas (secundárias, não removidas).
  assert.ok(await session.getByRole('button',{name:'Sair da conta'}).isVisible());assert.ok(await password.isVisible());
  assert.ok(await bookings.getByText(/Você ainda não tem reservas/).isVisible());
  ui.assertNoLeak();
 }finally{await context.close();}
});

test('admin 390×844: primeiro registro e ação primária na primeira dobra, com navegação e controles completos',{timeout:300_000},async()=>{
 const long=`fixui-participante-${randomBytes(4).toString('hex')}-com-identificador-muito-longo@example.invalid`;
 await one("insert into participant(email,goal,moment,interests,skills,area,token_hash,consent_version,active) values($1,'growth','working','[\"dados\"]','[\"analise\"]','dados',$2,'v1',true) returning id",[long,randomBytes(32).toString('hex')]);
 const {page,context}=await ui.newPage({viewport:FOLD});
 try{
  await context.addInitScript(()=>localStorage.setItem('tw-theme','dark'));
  await activate(page,`fixui-admin-${randomBytes(4).toString('hex')}@example.invalid`,'admin');
  await page.goto(ui.origin+'/admin');
  const nav=main(page).getByRole('navigation',{name:'Recursos do painel'});await nav.waitFor();
  const first=main(page).getByRole('list',{name:'Participantes'}).getByRole('listitem').first();await first.waitFor();
  await page.waitForLoadState('networkidle');await page.evaluate(()=>document.fonts.ready);await page.evaluate(()=>window.scrollTo(0,0));
  // Controles preservados: quatro recursos, conteúdo do evento e saída.
  for(const t of ['Participantes','Mentoras','Cruzamentos','Usuários'])assert.ok(await nav.getByRole('button',{name:t,exact:true}).isVisible(),t);
  assert.ok(await nav.getByRole('link',{name:'Conteúdo do evento'}).isVisible());
  assert.ok(await main(page).getByRole('button',{name:/Sair da conta/}).isVisible());
  const create=await box(main(page).getByRole('button',{name:'Cadastrar participante'}));
  // Primeiro registro da lista (a ordem é do servidor); o e-mail longo da fixture é medido também.
  const record=await box(first),identifier=await box(first.getByRole('heading').first());
  const edit=await box(first.getByRole('button',{name:/^Editar /}));
  const longRecord=main(page).getByRole('list',{name:'Participantes'}).getByRole('listitem').filter({has:page.getByRole('heading',{name:long})});
  assert.equal(await longRecord.getByRole('heading',{name:long}).evaluate(e=>e.scrollWidth>e.clientWidth),false,'e-mail longo sem overflow');
  records.push({name:'admin-390x844',primaryAction:create,firstRecord:record,identifier,firstEdit:edit});
  assert.ok(inFold(create),`ação primária na primeira dobra: ${JSON.stringify(create)}`);
  assert.ok(record.y<FOLD.height&&inFold(identifier),`primeiro registro (identificador) na primeira dobra: ${JSON.stringify(identifier)}`);
  await noOverflow(page);
  // Teclado: o primeiro recurso e a ação primária seguem alcançáveis; Enter abre o cadastro com foco no primeiro campo.
  const createButton=main(page).getByRole('button',{name:'Cadastrar participante'});
  assert.equal(await firstByTab(page,[createButton]),0);
  await page.keyboard.press('Enter');
  await page.waitForFunction(()=>document.activeElement?.id==='participant-email');
  ui.assertNoLeak();
 }finally{await context.close();}
});

/** Participante na conta com uma mentora sugerida (9 = 3+3+2+1) já renderizada. */
async function accountWithSuggestion(width:number,label:string){
 const name=`Mentora ${label} ${width}`;await mentorWithCohort(name);
 const opened=await ui.newPage({viewport:{width,height:width===390?844:900}});
 await activate(opened.page,`fixui-${label.toLowerCase()}-${randomBytes(4).toString('hex')}@example.invalid`);
 await opened.page.reload();const card=main(opened.page).locator('article.choice-mentor').filter({has:opened.page.getByRole('heading',{name,exact:true})});await card.waitFor();
 await opened.page.evaluate(()=>document.fonts.ready);
 return {...opened,name,card};
}

for(const width of [390,1440]){
 test(`tipografia ${width}: títulos das seções da conta seguem uma mesma regra`,{timeout:300_000},async()=>{
  const {page,context}=await accountWithSuggestion(width,'Titulos');
  try{
   const titles=await page.evaluate(()=>['account-title','enrollments-title','journey-title'].map(id=>{const s=getComputedStyle(document.getElementById(id)!);return {id,family:s.fontFamily,transform:s.textTransform,weight:s.fontWeight};}));
   records.push({name:`titulos-conta-${width}`,titles});
   for(const t of titles.slice(1))assert.deepEqual({family:t.family,transform:t.transform,weight:t.weight},{family:titles[0].family,transform:titles[0].transform,weight:titles[0].weight},`título ${t.id} coerente com ${titles[0].id}`);
   await noOverflow(page);ui.assertNoLeak();
  }finally{await context.close();}
 });

 test(`pontos ${width}: motivos e total inalterados, +1 ponto no singular${width===390?' e score alinhado ao nome':''}`,{timeout:300_000},async()=>{
  const {page,context,name,card}=await accountWithSuggestion(width,'Pontos');
  try{
   const reasons=await card.getByRole('list',{name:'Motivos da sugestão'}).getByRole('listitem').allInnerTexts();
   records.push({name:`motivos-${width}`,reasons});
   assert.deepEqual(reasons,['Área de atuação em comum: Dados (+3 pontos)','Objetivo e especialidades: Dados (+3 pontos)','Interesses em comum: Dados (+2 pontos)','Habilidades relacionadas: Análise (+1 ponto)']);
   const score=card.getByLabel('Afinidade: 9 pontos');assert.equal((await score.innerText()).replace(/\s+/g,' ').trim(),'9 PONTOS');
   // No mobile o score começa na mesma coluna do nome da mentora.
   if(width===390){const s=await box(score),h=await box(card.getByRole('heading',{name,exact:true}));records.push({name:'score-390',score:s,heading:h});assert.ok(Math.abs(s.x-h.x)<=1,`score alinhado ao nome: ${s.x} vs ${h.x}`);}
   await noOverflow(page);ui.assertNoLeak();
  }finally{await context.close();}
 });

 test(`identificador ${width}: e-mail do registro admin em fonte de leitura, sem caixa alta nem overflow`,{timeout:300_000},async()=>{
  const long=`fixui-tipo-registro-${randomBytes(4).toString('hex')}-identificador-extenso@example.invalid`;
  await one("insert into participant(email,goal,moment,interests,skills,area,token_hash,consent_version,active) values($1,'growth','working','[\"dados\"]','[\"analise\"]','dados',$2,'v1',true) returning id",[long,randomBytes(32).toString('hex')]);
  const {page,context}=await ui.newPage({viewport:{width,height:width===390?844:900}});
  try{
   await activate(page,`fixui-tipo-admin-${randomBytes(4).toString('hex')}@example.invalid`,'admin');
   await page.goto(ui.origin+'/admin');const id=main(page).getByRole('heading',{name:long});await id.waitFor();await page.evaluate(()=>document.fonts.ready);
   const body=await page.evaluate(()=>getComputedStyle(document.body).fontFamily);
   const style=await id.evaluate(e=>{const s=getComputedStyle(e);return {family:s.fontFamily,transform:s.textTransform,overflow:e.scrollWidth>e.clientWidth};});
   records.push({name:`identificador-admin-${width}`,body,...style});
   assert.equal(style.family,body,'identificador usa a família de corpo');assert.match(style.family,/DM Sans/);
   assert.equal(style.transform,'none');assert.equal(style.overflow,false,'identificador longo sem overflow');
   await noOverflow(page);ui.assertNoLeak();
  }finally{await context.close();}
 });
}
