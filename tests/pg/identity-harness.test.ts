/** Utilitários compartilhados dos testes de identidade (sem testes próprios). Banco isolado por teste; app roda como techwoman_runtime. */
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID,randomBytes} from 'node:crypto';
import {migrate} from '../../scripts/migration/migrate';
import {closeDb,hashPassword,tokenDigest} from '../../src/lib/db';
import {newSessionToken} from '../../src/lib/identity';
import {closeEmailPool} from '../../src/lib/email';

export const base=process.env.MIGRATION_DATABASE_URL;
export type Ctx={db:Pool;url:string;runtimeUrl:string};
export const synthetic=()=>`pw-${randomBytes(12).toString('base64url')}`;
export const roleUrl=(url:string,role:string)=>{const u=new URL(url);u.searchParams.set('options',`-c role=${role} -c jit=off`);return u.toString();};
/** Espera os backends encerrarem antes do DROP: derrubar socket ainda fechando gera erro assíncrono após o teste. */
const settled=async(control:Pool,name:string)=>{for(let i=0;i<80;i++){if(!(await control.query('select 1 from pg_stat_activity where datname=$1',[name])).rowCount)return;await new Promise(r=>setTimeout(r,50));}};
const ENV_KEYS=['DATABASE_URL','MAILER_DATABASE_URL','RATE_LOGIN_PAIR_PER_MIN','RATE_EMAIL_PER_HOUR','EMAIL_MODE','MENTOR_DEADLINE','SESSION_SECRET','APP_ORIGIN','TRUST_PROXY','RATE_LIMIT_SECRET','NODE_ENV','ALLOW_LOCAL_HTTP','RATE_PREVIEW_IP_PER_HOUR','RATE_IP_PER_HOUR'] as const;

export async function withDb(fn:(ctx:Ctx)=>Promise<void>,env:Partial<Record<typeof ENV_KEYS[number],string>>={}){
 assert.ok(base,'MIGRATION_DATABASE_URL');const control=new Pool({connectionString:base});const name='tw_acc_'+randomUUID().replace(/-/g,'');
 const created:string[]=[];
 for(const role of ['techwoman_runtime','techwoman_mailer']){ if(!(await control.query('select 1 from pg_roles where rolname=$1',[role])).rowCount){await control.query(`create role ${role} nologin`);created.push(role);} }
 await control.query(`create database ${name}`);const u=new URL(base);u.pathname='/'+name;const url=u.toString();
 const db=new Pool({connectionString:url,max:8,options:'-c jit=off'});
 const previous=Object.fromEntries(ENV_KEYS.map(k=>[k,process.env[k]]));
 try{
  await migrate(url);await closeDb();await closeEmailPool();
  process.env.SESSION_SECRET=randomBytes(48).toString('hex');process.env.APP_ORIGIN='http://app.example.invalid';
  for(const [k,v] of Object.entries(env))Reflect.set(process.env,k,v);
  const runtimeUrl=roleUrl(url,'techwoman_runtime');process.env.DATABASE_URL=runtimeUrl;process.env.MAILER_DATABASE_URL=roleUrl(url,'techwoman_mailer');
  await fn({db,url,runtimeUrl});
 }finally{
  await closeDb();await closeEmailPool();for(const k of ENV_KEYS){const v=previous[k];if(v===undefined)Reflect.deleteProperty(process.env,k);else Reflect.set(process.env,k,v);}
  await db.end();await settled(control,name);await control.query(`drop database ${name} with (force)`);for(const role of created)await control.query(`drop role if exists ${role}`).catch(()=>undefined);await control.end();
 }
}
export async function addUser(db:Pool,opts:{email?:string;status?:string;password?:string;roles?:string[];mustChange?:boolean}={}){
 const id=randomUUID(),email=opts.email??`u-${id.slice(0,8)}@example.invalid`;
 await db.query("insert into app_user(id,email,status,password_hash) values($1,$2,$3,$4)",[id,email,opts.status??'active',opts.password?await hashPassword(opts.password):null]);
 for(const role of opts.roles??['participant'])await db.query('insert into user_role(user_id,role) values($1,$2)',[id,role]);
 return {id,email};
}
/** Sessão inserida como dono do banco: token conhecido só no teste. */
export async function sessionFor(db:Pool,userId:string,scope:'full'|'password_change'='full'){
 const token=newSessionToken();
 await db.query("insert into auth_session(id,user_id,token_hash,scope,session_version,expires_at) select gen_random_uuid(),id,$2,$3,session_version,now()+interval '1 hour' from app_user where id=$1",[userId,tokenDigest(token),scope]);
 return token;
}
export const participantRow=(db:Pool,id:number,email:string,userId:string|null=null)=>db.query("insert into participant(id,email,goal,moment,interests,skills,token_hash,consent_version,user_id) values($1,$2,'growth','working','[]','[]',$3,'v0',$4)",[id,email,String(id).padStart(64,'e'),userId]);
export const mentorRow=(db:Pool,id:number,email:string,userId:string|null=null)=>db.query("insert into mentor(id,email,trajectory,specialties,availability,capacity,user_id) values($1,$2,'t','[]','a',2,$3)",[id,email,userId]);
export async function linkFixture(db:Pool){
 const run=randomUUID();await db.query("insert into migration_run(id,source_checksum,status) values($1,$2,'pending')",[run,run]);
 return {
  link:(table:string,key:string,user:string|null,resolution:string)=>db.query('insert into migration_identity_link(run_id,source_table,source_key,user_id,resolution) values($1,$2,$3,$4,$5)',[run,table,key,user,resolution]),
  issue:(table:string,key:string,code:string,resolved=false)=>db.query('insert into migration_issue(id,run_id,source_table,source_key,code,resolved_at) values(gen_random_uuid(),$1,$2,$3,$4,$5)',[run,table,key,code,resolved?new Date().toISOString():null]),
 };
}
/** Reserva ativa de um participante numa turma futura do mentor indicado (fixtures como dono do banco). */
export async function activeEnrollment(db:Pool,participantId:number,mentorId:number){
 const topic=(await db.query("insert into topic(slug,name) values($1,'Tema') returning id",['t-'+randomBytes(4).toString('hex')])).rows[0].id;
 const mt=(await db.query("insert into mentor_topic(mentor_id,topic_id,position) values($1,$2,1) returning id",[mentorId,topic])).rows[0].id;
 const cohort=(await db.query("insert into cohort(mentor_topic_id,starts_at,ends_at,capacity,status) values($1,now()+interval '30 days',now()+interval '30 days 1 hour',5,'open') returning id",[mt])).rows[0].id;
 await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active')",[participantId,cohort]);
}
