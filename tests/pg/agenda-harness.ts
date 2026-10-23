/** Utilitários dos testes de Agenda (sem testes próprios). Banco isolado por teste via identity-harness; fixtures gravadas como dono do banco. */
import assert from 'node:assert/strict';
import {Client,type Pool} from 'pg';
import {randomBytes} from 'node:crypto';
import {roleUrl} from './identity-harness.test';

export {withDb} from './identity-harness.test';
export const EDITOR='techwoman_beatriz';
export const OWNER='techwoman_owner';

/** Instante futuro alinhado à hora (base comum + deslocamento em horas), ISO UTC. */
const BASE=Math.ceil((Date.now()+7*24*3600e3)/3600e3)*3600e3;
export const at=(hours:number)=>new Date(BASE+hours*3600e3).toISOString();

/** Cliente independente (conexão própria); role opcional via options, como o runtime. */
export async function connect(url:string,role?:string){const c=new Client({connectionString:role?roleUrl(url,role):url});await c.connect();return c;}
export async function withClients<T>(url:string,roles:(string|undefined)[],fn:(...c:Client[])=>Promise<T>){
 const cs=await Promise.all(roles.map(r=>connect(url,r)));
 try{return await fn(...cs);}finally{await Promise.all(cs.map(c=>c.end().catch(()=>undefined)));}
}
export const revision=async(db:Pool|Client)=>BigInt((await db.query('select revision from internal.agenda_guard where id=1')).rows[0].revision);

/** Erro PG esperado por SQLSTATE e, quando informado, pelo nome estável da constraint. */
export async function pgFails(p:Promise<unknown>,code:string,constraint?:string){
 await assert.rejects(p,(e:{code?:string;constraint?:string;message?:string})=>{
  assert.equal(e.code,code,`SQLSTATE esperado ${code}, obtido ${e.code}: ${e.message}`);
  if(constraint)assert.equal(e.constraint,constraint,`constraint esperada ${constraint}: ${e.message}`);
  return true;
 });
}
/** Espera o backend `pid` ficar bloqueado aguardando lock (barreira real, sem sleep fixo). */
export async function waitLocked(control:Pool|Client,pid:number){
 for(let i=0;i<200;i++){const r=await control.query("select wait_event_type from pg_stat_activity where pid=$1",[pid]);if(r.rows[0]?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,25));}
 assert.fail(`backend ${pid} não bloqueou no lock`);
}
export const pidOf=async(c:Client)=>(await c.query('select pg_backend_pid() pid')).rows[0].pid as number;

type Q=Pool|Client;
const one=async(db:Q,sql:string,args:unknown[])=>String((await db.query(sql,args)).rows[0].id);
export const addTopic=(db:Q,o:{active?:boolean}={})=>one(db,"insert into topic(slug,name,active) values($1,'Tema',$2) returning id",['t-'+randomBytes(4).toString('hex'),o.active??true]);
export const addMentor=(db:Q,o:{userId?:string|null;email?:string;active?:boolean}={})=>one(db,"insert into mentor(email,trajectory,specialties,availability,capacity,active,display_name,user_id) values($1,'t','[]','a',2,$2,'Mentora',$3) returning id",[o.email??`m-${randomBytes(4).toString('hex')}@example.invalid`,o.active??true,o.userId??null]);
export const addParticipant=(db:Q,o:{userId?:string|null;email?:string;active?:boolean}={})=>one(db,"insert into participant(email,goal,moment,interests,skills,area,token_hash,consent_version,user_id,active) values($1,'growth','working','[\"dados\"]','[\"codigo\"]','dados',$2,'v1',$3,$4) returning id",[o.email??`p-${randomBytes(4).toString('hex')}@example.invalid`,randomBytes(32).toString('hex'),o.userId??null,o.active??true]);
export const addMentorTopic=(db:Q,mentorId:string,topicId:string,position=1)=>one(db,'insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,$3) returning id',[mentorId,topicId,position]);
export const addCohort=(db:Q,mentorTopicId:string,o:{from?:number;hours?:number;capacity?:number;status?:string}={})=>{const from=o.from??0;
 return one(db,'insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,$2,$3,$4,$5) returning id',[mentorTopicId,at(from),at(from+(o.hours??1)),o.capacity??5,o.status??'open']);};
/** Mentora com um tema e uma turma aberta: atalho das fixtures. */
export async function mentorWithCohort(db:Q,o:{from?:number;hours?:number;capacity?:number;status?:string;userId?:string|null}={}){
 const mentor=await addMentor(db,{userId:o.userId});const topic=await addTopic(db);const mentorTopic=await addMentorTopic(db,mentor,topic);
 return {mentor,topic,mentorTopic,cohort:await addCohort(db,mentorTopic,o)};
}
/** Turma que já começou (simula o tempo passando): única fixture gravada sem triggers, numa transação própria do dono. */
export async function startedCohort(url:string,mentorTopicId:string,o:{hoursAgo?:number;hours?:number;capacity?:number;status?:string}={}){
 return withClients(url,[undefined],async c=>{
  await c.query('begin');await c.query('set local session_replication_role=replica');
  const from=new Date(Date.now()-(o.hoursAgo??1)*3600e3);
  const id=await one(c,'insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,$2,$3,$4,$5) returning id',[mentorTopicId,from.toISOString(),new Date(from.getTime()+(o.hours??2)*3600e3).toISOString(),o.capacity??5,o.status??'open']);
  await c.query('commit');return id;
 });
}
