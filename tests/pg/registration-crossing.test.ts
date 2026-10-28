/** Cadastro com crossing (AJUSTE-INSCRICAO): preview sem persistência, ranking reaproveitado e finalização atômica com senha definitiva. PG16 real. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client} from 'pg';
import {withDb,roleUrl} from './identity-harness.test';
import {DIAGNOSTIC,crossingMentors,fullSnapshot,type Q} from './crossing-fixtures';

const previewSql=(db:Q,d:Record<string,unknown>=DIAGNOSTIC)=>db.query('select internal.registration_preview($1,$2,$3::jsonb,$4::jsonb,$5) r',[d.goal,d.moment,JSON.stringify(d.interests),JSON.stringify(d.skills),d.area]);

test('preview SQL: só compatíveis (ativa, não protegida, score>0) na ordem do ranking, nome ou (MENTORA), sem turma exigida e sem escrita',async()=>withDb(async({db,url})=>{
 const m=await crossingMentors(db);
 const before=await fullSnapshot(db);
 const runtime=new Client({connectionString:roleUrl(url,'techwoman_runtime')});await runtime.connect();
 try{
  const rows=(await previewSql(runtime)).rows[0].r as {id:string;name:string}[];
  assert.deepEqual(rows,[{id:m.eva,name:'Eva Demo'},{id:m.ana,name:'Ana Dados'},{id:m.semNome,name:'(MENTORA)'},{id:m.gabi,name:'Gabi Demo'}]);
  // sem compatíveis: lista vazia, nunca um "match" inventado
  const none=(await previewSql(runtime,{...DIAGNOSTIC,goal:'transition',interests:['desenvolvimento'],skills:['codigo'],area:'outra: Biotecnologia'})).rows[0].r;
  assert.deepEqual(none,[]);
  for(const bad of [{...DIAGNOSTIC,goal:'x'},{...DIAGNOSTIC,moment:'x'},{...DIAGNOSTIC,interests:'dados'},{...DIAGNOSTIC,area:''}])
   await assert.rejects(previewSql(runtime,bad),(e:{code?:string})=>e.code==='P0001','diagnóstico inválido recusado no banco');
 }finally{await runtime.end();}
 assert.deepEqual(await fullSnapshot(db),before,'preview não grava nada (nem sequence)');
}));

test('ranking por valores = ranking legado por participante (uma só implementação)',async()=>withDb(async({db})=>{
 const m=await crossingMentors(db);
 const p=(await db.query("insert into participant(email,goal,moment,interests,skills,area,token_hash,consent_version) values('p@example.invalid',$1,$2,$3,$4,$5,$6,'v1') returning id",
  [DIAGNOSTIC.goal,DIAGNOSTIC.moment,JSON.stringify(DIAGNOSTIC.interests),JSON.stringify(DIAGNOSTIC.skills),DIAGNOSTIC.area,'c'.repeat(64)])).rows[0].id;
 for(const id of Object.values(m)){
  const legacy=(await db.query('select (internal.agenda_ranking($1,$2)).* ',[p,id])).rows[0];
  const values=(await db.query('select (internal.agenda_ranking_values($1,$2::jsonb,$3::jsonb,$4,$5)).*',[DIAGNOSTIC.goal,JSON.stringify(DIAGNOSTIC.interests),JSON.stringify(DIAGNOSTIC.skills),DIAGNOSTIC.area,id])).rows[0];
  assert.deepEqual(values,legacy,`mentora ${id}`);
 }
 assert.deepEqual((await db.query('select (internal.agenda_ranking($1,$2)).*',[p,m.eva])).rows[0],{o_score:12,o_reasons:['Área de atuação em comum: dados (+3)','Objetivo e especialidades: dados (+3)','Interesses em comum: dados, design (+4)','Habilidades relacionadas: analise, gestao (+2)']});
}));
