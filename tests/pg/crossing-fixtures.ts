/** Fixtures determinísticas do cadastro com crossing (AJUSTE-INSCRICAO). Sem testes próprios. */
import type {Client,Pool} from 'pg';

export type Q=Pool|Client;
export const DIAGNOSTIC={goal:'growth',moment:'working',interests:['dados','design'],skills:['analise','gestao'],area:'dados'};

/**
 * Conteúdo integral de todas as tabelas da aplicação (exceto baldes de rate e as tabelas em `skip`): qualquer escrita muda o snapshot.
 * `sequences` inclui match/participant: só serve onde nada deveria nem tentar inserir (sequences do PG não voltam no ROLLBACK).
 */
export async function fullSnapshot(db:Q,o:{sequences?:boolean;skip?:string[]}={}):Promise<Record<string,string>>{
 const skip=['public.auth_rate_bucket',...(o.skip??[])];
 const tables=(await db.query("select schemaname||'.'||tablename t from pg_tables where schemaname in ('public','internal','legacy_snapshot') order by 1")).rows.map(r=>String(r.t)).filter(t=>!skip.includes(t));
 const out:Record<string,string>={};
 for(const t of tables)out[t]=String((await db.query(`select count(*)::text||':'||md5(coalesce(string_agg(x::text,'|' order by x::text),'')) s from ${t} x`)).rows[0].s);
 if(!o.sequences)return out;
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
