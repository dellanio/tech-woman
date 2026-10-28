/** Cadastro com crossing (AJUSTE-INSCRICAO): preview sem persistência, ranking reaproveitado e finalização atômica com senha definitiva. PG16 real. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Client,Pool} from 'pg';
import {withDb,roleUrl} from './identity-harness.test';

type Q=Pool|Client;
const DIAGNOSTIC={goal:'growth',moment:'working',interests:['dados','design'],skills:['analise','gestao'],area:'dados'};

/** Conteúdo integral de todas as tabelas da aplicação (exceto baldes de rate): qualquer escrita muda o snapshot. */
export async function fullSnapshot(db:Q):Promise<Record<string,string>>{
 const tables=(await db.query("select schemaname||'.'||tablename t from pg_tables where schemaname in ('public','internal','legacy_snapshot') and tablename<>'auth_rate_bucket' order by 1")).rows.map(r=>String(r.t));
 const out:Record<string,string>={};
 for(const t of tables)out[t]=String((await db.query(`select count(*)::text||':'||md5(coalesce(string_agg(x::text,'|' order by x::text),'')) s from ${t} x`)).rows[0].s);
 out['seq:match']=String((await db.query('select last_value::text||is_called::text v from public.match_id_seq')).rows[0].v);
 out['seq:participant']=String((await db.query('select last_value::text||is_called::text v from public.participant_id_seq')).rows[0].v);
 return out;
}

/** Mentoras determinísticas do diagnóstico acima (ranking legado: objetivo+especialidade 3, interesse 2, habilidade 1, área 3). */
export async function crossingMentors(db:Q){
 const mentor=async(o:{email:string;specialties:string[];display?:string|null;demo?:boolean;demoName?:string|null;active?:boolean})=>String((await db.query(
  "insert into mentor(email,trajectory,specialties,availability,capacity,active,demo,demo_name,display_name) values($1,'t',$2,'a',2,$3,$4,$5,$6) returning id",
  [o.email,JSON.stringify(o.specialties),o.active??true,o.demo??false,o.demoName??null,o.display??null])).rows[0].id);
 const ana=await mentor({email:'ana@example.invalid',specialties:['dados'],display:'Ana Dados'});              // 3+2+1+3 = 9
 const semNome=await mentor({email:'real@example.invalid',specialties:['design']});                          // 0+2+1+0 = 3 → (MENTORA)
 const zero=await mentor({email:'zero@example.invalid',specialties:['produto'],demo:true,demoName:'Demo Zero'}); // 0 → fora
 const inativa=await mentor({email:'off@example.invalid',specialties:['design','dados'],display:'Dani',active:false});
 const eva=await mentor({email:'eva@example.invalid',specialties:['dados','design'],display:'Eva Demo',demo:true,demoName:'Outro'}); // 3+4+2+3 = 12
 const protegida=await mentor({email:'Chefe@Example.invalid',specialties:['dados'],display:'Protegida'});
 await db.query("insert into app_user(id,email,status) values(gen_random_uuid(),'chefe@example.invalid','active')");
 await db.query("insert into user_role(user_id,role) select id,'admin' from app_user where email='chefe@example.invalid'");
 const gabi=await mentor({email:'gabi@example.invalid',specialties:['design'],display:'  ',demo:true,demoName:'Gabi Demo'}); // 3, empate com semNome → id
 // turma aberta só da Ana: compatibilidade não depende de turma/capacidade
 const topic=(await db.query("insert into topic(slug,name) values('crossing','Tema') returning id")).rows[0].id;
 const mt=(await db.query('insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,1) returning id',[ana,topic])).rows[0].id;
 await db.query("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,now()+interval '30 days',now()+interval '30 days 1 hour',1,'open')",[mt]);
 return {ana,semNome,zero,inativa,eva,protegida,gabi};
}
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
