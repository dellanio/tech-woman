/** Utilitários dos testes HTTP de Agenda (sem testes próprios). Handlers reais com Request + params Promise, app como techwoman_runtime. */
import type {Pool} from 'pg';
import * as csrfRoute from '../../src/app/api/v1/auth/csrf/route';
import {addUser,sessionFor,synthetic} from './identity-harness.test';
import {call,type Reply} from './identity-http-kit.test';
import {addMentor,addParticipant} from './agenda-harness';

export {call,code,sameShape,type Reply} from './identity-http-kit.test';
export type Actor={id:string;token:string;csrf:string};
const csrfFor=async(token:string)=>String((await call(csrfRoute.GET,'/api/v1/auth/csrf',{cookie:token})).json.data.csrfToken);
/** Usuária ativa com sessão full e CSRF; `email` opcional para fixtures de proteção. */
export async function actorOf(db:Pool,roles:string[],o:{email?:string}={}):Promise<Actor>{
 const u=await addUser(db,{password:synthetic(),roles,email:o.email});const token=await sessionFor(db,u.id);return {id:u.id,token,csrf:await csrfFor(token)};
}
/** Mentora com conta própria (papel mentor) e linha de domínio vinculada. */
export async function mentorActor(db:Pool,o:{specialties?:string[];roles?:string[]}={}){
 const actor=await actorOf(db,o.roles??['mentor']);const mentorId=await addMentor(db,{userId:actor.id,specialties:o.specialties});return {...actor,mentorId};
}
/** Participante reconciliada (papel participant) com perfil de diagnóstico. */
export async function participantActor(db:Pool,o:{goal?:string;interests?:string[];skills?:string[];area?:string|null;roles?:string[]}={}){
 const actor=await actorOf(db,o.roles??['participant']);const participantId=await addParticipant(db,{userId:actor.id,goal:o.goal,interests:o.interests,skills:o.skills,area:o.area});return {...actor,participantId};
}
export const etagOf=(r:Reply)=>String(r.headers.get('etag')).replace(/"/g,'');
/** Requisição autenticada: GET por padrão; mutações levam CSRF e, se houver, If-Match/Idempotency-Key. */
export function as(a:Actor){
 return {
  get:(handler:Parameters<typeof call>[0],path:string,params?:Record<string,string>)=>call(handler,path,{cookie:a.token,params}),
  send:(handler:Parameters<typeof call>[0],path:string,o:{method?:string;body?:unknown;params?:Record<string,string>;version?:string;key?:string;headers?:Record<string,string|null>}={})=>
   call(handler,path,{method:o.method??'POST',body:o.body,cookie:a.token,csrf:a.csrf,params:o.params,key:o.key,headers:{...(o.version?{'If-Match':o.version}:{}),...(o.headers??{})}}),
 };
}
/** Fotografia das tabelas de domínio/efeitos para provar "zero mutação". */
export const snapshot=async(db:Pool)=>JSON.stringify((await db.query(`select
 (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from topic x) topics,(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from mentor_topic x) links,
 (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from cohort x) cohorts,(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from enrollment x) enrollments,
 (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from match x) matches,(select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from participant x) participants,
 (select coalesce(jsonb_agg(to_jsonb(x) order by id),'[]') from mentor x) mentors,(select count(*)::int from email_job) jobs,(select count(*)::int from audit_event) audits,
 (select count(*)::int from api_idempotency) idem,(select count(*)::int from app_user) users`)).rows[0]);
