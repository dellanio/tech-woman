/** Respostas reais PG atrasadas: uma seleção anterior nunca substitui as turmas atuais. */
import {after,before,test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {startUi,type Ui} from './ui-harness';
let ui:Ui;
before(async()=>{ui=await startUi('ui-cohort-race');await ui.db.query(readFileSync('scripts/migration/grants-local.sql','utf8'));},{timeout:420000});
after(async()=>{await ui?.stop();});
test('rede lenta: resposta anterior não troca as turmas da mentora atual nem a reserva',{timeout:300000},async()=>{
 const suffix=randomBytes(4).toString('hex');
 async function mentor(name:string,days:number){
  const id=String((await ui.db.query("insert into mentor(email,trajectory,specialties,availability,capacity,active,display_name) values($1,'Fixture sintética.','[\"dados\"]','No evento.',2,true,$2) returning id",[name+'-'+suffix+'@example.invalid',name])).rows[0].id);
  const topic=String((await ui.db.query('insert into topic(slug,name,active) values($1,$2,true) returning id',['race-'+name.toLowerCase()+'-'+suffix,'Tema '+name])).rows[0].id);
  const mt=String((await ui.db.query('insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,1) returning id',[id,topic])).rows[0].id);
  const start=new Date(Date.now()+days*86400000);start.setUTCHours(12,0,0,0);
  const cohort=String((await ui.db.query("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,$2,$3,2,'open') returning id",[mt,start.toISOString(),new Date(start.getTime()+3600000).toISOString()])).rows[0].id);
  return {id,cohort};
 }
 const a=await mentor('Alice',60),b=await mentor('Bruna',61);
 const email='race-'+suffix+'@example.invalid',temp=await ui.temporaryPassword(email);
 const {page,context}=await ui.newPage();
 let release=()=>{};const held=new Promise<void>(r=>{release=r;});
 let arrived=()=>{};const waiting=new Promise<void>(r=>{arrived=r;});
 let delivered=()=>{};const finished=new Promise<void>(r=>{delivered=r;});
 try{
  await page.goto(ui.origin+'/login');await page.getByLabel('E-mail').fill(email);await page.getByLabel('Senha',{exact:true}).fill(temp);await page.getByRole('button',{name:'Entrar',exact:true}).click();await page.waitForURL('**/troca-senha**');
  const secret='Recife-'+randomBytes(16).toString('hex');ui.secrets.add(secret);
  await page.getByLabel('Senha atual ou temporária').fill(temp);await page.getByLabel('Nova senha',{exact:true}).fill(secret);await page.getByLabel('Confirme a nova senha').fill(secret);await page.getByRole('button',{name:/Salvar nova senha/}).click();await page.waitForURL('**/conta');
  // A requisição de Alice continua até a API real, mas só depois de Bruna já estar exibida.
  await page.route('**/api/v1/mentors/'+a.id+'/cohorts*',async route=>{arrived();await held;await route.continue();delivered();});
  await page.getByRole('button',{name:'Ver temas e turmas de Alice',exact:true}).click();await waiting;
  await page.getByRole('button',{name:'Escolher outra mentora',exact:true}).click();
  await page.getByRole('button',{name:'Ver temas e turmas de Bruna',exact:true}).click();
  await page.getByRole('group',{name:'Tema Bruna',exact:true}).waitFor();
  const old=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/v1/mentors/'+a.id+'/cohorts');release();await finished;await old;await page.waitForLoadState('networkidle');
  assert.match(await page.locator('.choice-context').innerText(),/Bruna/i);
  assert.deepEqual(await page.locator('input[name=cohort]').evaluateAll(es=>es.map(e=>(e as HTMLInputElement).value)),[b.cohort],'somente turmas de Bruna após a resposta atrasada de Alice');
  await page.getByRole('group',{name:'Tema Bruna',exact:true}).getByRole('radio').check();await page.getByRole('button',{name:'Conferir resumo',exact:true}).click();
  assert.match(await page.locator('.choice-summary').innerText(),/Bruna/i);
  const response=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname==='/api/v1/me/enrollments');await page.getByRole('button',{name:'Reservar vaga',exact:true}).click();assert.equal((await response).status(),201);
  await page.getByRole('status').filter({hasText:'Reserva confirmada'}).waitFor();
  const rows=await ui.db.query('select e.cohort_id::text from enrollment e join participant p on p.id=e.participant_id where p.email=$1',[email]);assert.deepEqual(rows.rows,[{cohort_id:b.cohort}]);ui.assertNoLeak();
 }finally{release();await context.close();}
});
