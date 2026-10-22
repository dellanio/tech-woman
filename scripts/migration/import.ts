/** Offline somente: fonte protegida, conexão migradora, sem e-mail, seed ou fallback. */
import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { readSnapshot, records, type Snapshot } from './source';
type RecordRow=Record<string,string|null>;
type Issue={table:string;key:string;code:string};
export type ImportReport={dryRun:boolean;idempotent:boolean;runId:string|null;status:string;issues:number;counts:Record<string,number>};
const known:Record<string,string[]>={
 participant:['id','email','goal','moment','interests','skills','area','token_hash','consent_version','consent_at'],
 mentor:['id','email','trajectory','specialties','availability','capacity','active','demo','demo_name'],
 match:['id','participant_id','mentor_id','score','reasons','status'],admin_user:['email','password_hash','role'],
 email_attempt:['participant_id','status','provider_id','updated_at'],choice_email_attempt:['participant_id','mentor_id','status','provider_id','updated_at'],
 event_content:['id','description','venue','agenda','speakers','date','duration'],demo_seed_state:['id'],sqlite_sequence:['name','seq']
};
const normalize=(email:string)=>email.replace(/^ +| +$/g,'').toLowerCase();
function timestamp(value:string|null|undefined){if(!value||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)||Number.isNaN(Date.parse(value)))return null;return new Date(value).toISOString();}
function jsonArray(value:string|null|undefined){try{const list:unknown=JSON.parse(value||'');if(!Array.isArray(list)||!list.every(v=>typeof v==='string'))return null;return JSON.stringify(list);}catch{return null;}}
const quote=(name:string)=>'"'+name.replace(/"/g,'""')+'"';
async function insert(client:PoolClient,table:string,row:Record<string,unknown>){const fields=Object.keys(row);await client.query(`INSERT INTO public.${quote(table)}(${fields.map(quote).join(',')}) VALUES(${fields.map((_,i)=>'$'+(i+1)).join(',')})`,Object.values(row));}

export async function importSnapshot(snapshot:Snapshot,options:{url?:string;dryRun?:boolean}={}):Promise<ImportReport>{
 if(snapshot.format!==1||snapshot.integrity!=='ok'||!/^[a-f0-9]{64}$/.test(snapshot.checksum))throw new Error('Snapshot inválido.');
 const issues:Issue[]=[],tables=new Map(snapshot.tables.map(t=>[t.name,records(t)]));
 const issue=(table:string,key:string,code:string)=>issues.push({table,key,code});
 const counts=Object.fromEntries(snapshot.tables.map(t=>[t.name,t.rows.length]));
 for(const table of snapshot.tables){
  if(!known[table.name])issue(table.name,'*','UNEXPECTED_TABLE');
  else for(const col of table.columns.map(c=>String(c[1].value)))if(!known[table.name].includes(col))issue(table.name,'*','UNEXPECTED_COLUMN');
 }
 type SourceIdentity={table:string;key:string;email:string;row:RecordRow};const groups=new Map<string,SourceIdentity[]>();
 for(const name of ['admin_user','participant','mentor'])for(const row of tables.get(name)||[]){
  if(!row.email){issue(name,row.id||'*','MISSING_EMAIL');continue;}
  const key=normalize(row.email),group=groups.get(key)||[];group.push({table:name,key:name==='admin_user'?row.email:row.id!,email:row.email,row});groups.set(key,group);
 }
 const identities:{email:string;hash:string|null;role:string|null;members:SourceIdentity[];resolution:string}[]=[];
 const links:{table:string;key:string;user:number|null;resolution:string}[]=[];
 for(const [key,members] of groups){
  const admins=members.filter(m=>m.table==='admin_user'),domains=members.filter(m=>m.table!=='admin_user');
  if(admins.length>1){for(const m of members){issue(m.table,m.key,'CREDENTIAL_COLLISION');links.push({table:m.table,key:m.key,user:null,resolution:m.table==='admin_user'?'credential_conflict':'privileged_candidate'});}continue;}
  if(admins.length){const admin=admins[0];if(!['owner','member'].includes(admin.row.role||'')||!admin.row.password_hash||!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(admin.row.password_hash)){issue(admin.table,admin.key,'UNSUPPORTED_CREDENTIAL');for(const m of members)links.push({table:m.table,key:m.key,user:null,resolution:'privileged_candidate'});continue;}
   const index=identities.length;identities.push({email:admin.email,hash:admin.row.password_hash,role:admin.row.role==='owner'?'admin':'team',members:[admin],resolution:'legacy_credential'});links.push({table:admin.table,key:admin.key,user:index,resolution:'legacy_credential'});
   for(const m of domains){issue(m.table,m.key,'PRIVILEGED_DOMAIN_UNRESOLVED');links.push({table:m.table,key:m.key,user:null,resolution:'privileged_candidate'});}continue;
  }
  const ambiguous=['participant','mentor'].some(table=>domains.filter(m=>m.table===table).length>1);
  if(ambiguous){for(const m of domains){issue(m.table,m.key,'DOMAIN_COLLISION');links.push({table:m.table,key:m.key,user:null,resolution:'ambiguous_domain'});}continue;}
  const index=identities.length;identities.push({email:members[0].email,hash:null,role:null,members,resolution:'awaiting_email_proof'});for(const m of members)links.push({table:m.table,key:m.key,user:index,resolution:'awaiting_email_proof'});
  if(!/^[\x21-\x7e]+@[^@]+\.[^@]+$/.test(key))issue(members[0].table,members[0].key,'UNUSUAL_EMAIL');
 }
 const valid=new Map<string,RecordRow[]>();
 for(const name of ['participant','mentor','match'])for(const row of tables.get(name)||[]){
  const fields=name==='participant'?['interests','skills']:name==='mentor'?['specialties']:['reasons'];
  if(fields.some(f=>jsonArray(row[f])===null)){issue(name,row.id||'*','INVALID_JSON');continue;}
  valid.set(name,[...(valid.get(name)||[]),row]);
 }
 for(const row of tables.get('participant')||[])if(row.consent_at&&!timestamp(row.consent_at))issue('participant',row.id!,'INVALID_TIMESTAMP');
 for(const name of ['email_attempt','choice_email_attempt'])for(const row of tables.get(name)||[])if(row.updated_at&&!timestamp(row.updated_at))issue(name,row.participant_id!,'INVALID_TIMESTAMP');
 const report:ImportReport={dryRun:!!options.dryRun,idempotent:false,runId:null,status:issues.length?'pending':'imported',issues:issues.length,counts};
 if(options.dryRun)return report;
 const url=options.url||process.env.MIGRATION_DATABASE_URL;if(!url)throw new Error('Conexão migradora obrigatória.');
 const pool=new Pool({connectionString:url,max:1}),client=await pool.connect();
 try{
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(741001)');
  const previous=await client.query('SELECT id,status FROM public.migration_run WHERE source_checksum=$1',[snapshot.checksum]);
  if(previous.rowCount){await client.query('ROLLBACK');return {...report,runId:previous.rows[0].id,idempotent:true,status:previous.rows[0].status};}
  const targets=await client.query("SELECT tablename FROM pg_tables WHERE schemaname='public'");
  for(const {tablename} of targets.rows){const count=await client.query(`SELECT EXISTS(SELECT 1 FROM public.${quote(tablename)}) AS occupied`);if(count.rows[0].occupied)throw new Error('Importação exige destino vazio/isolado; não sincroniza PostgreSQL em uso.');}
  const runId=randomUUID();report.runId=runId;await client.query('INSERT INTO public.migration_run(id,source_checksum,status) VALUES($1,$2,$3)',[runId,snapshot.checksum,report.status]);
  for(const table of snapshot.tables){
   await client.query('INSERT INTO legacy_snapshot.source_table(run_id,name,ddl,columns) VALUES($1,$2,$3,$4::jsonb)',[runId,table.name,table.ddl,JSON.stringify(table.columns)]);
   for(let i=0;i<table.rows.length;i++)await client.query('INSERT INTO legacy_snapshot.source_row(run_id,table_name,row_number,cells) VALUES($1,$2,$3,$4::jsonb)',[runId,table.name,i+1,JSON.stringify(table.rows[i])]);
  }
  const ids:string[]=[];
  for(const identity of identities){const id=randomUUID();ids.push(id);await insert(client,'app_user',{id,email:identity.email,password_hash:identity.hash,status:identity.hash?'active':'pending_activation'});if(identity.role)await insert(client,'user_role',{user_id:id,role:identity.role});}
  for(const link of links)await insert(client,'migration_identity_link',{run_id:runId,source_table:link.table,source_key:link.key,user_id:link.user===null?null:ids[link.user],resolution:link.resolution});
  const participantIds=new Set<string>(),mentorIds=new Set<string>();
  for(const row of valid.get('participant')||[]){
   await insert(client,'participant',{id:row.id,email:row.email,goal:row.goal,moment:row.moment,interests:jsonArray(row.interests),skills:jsonArray(row.skills),area:row.area??null,token_hash:row.token_hash,consent_version:row.consent_version,consent_at:timestamp(row.consent_at),consent_at_raw:row.consent_at??'',imported_at:new Date().toISOString()});participantIds.add(row.id!);
  }
  for(const row of valid.get('mentor')||[]){
   await insert(client,'mentor',{id:row.id,email:row.email,trajectory:row.trajectory,specialties:jsonArray(row.specialties),availability:row.availability,capacity:row.capacity,active:row.active==='1',demo:row.demo==='1',demo_name:row.demo_name??null,imported_at:new Date().toISOString()});mentorIds.add(row.id!);
  }
  for(const row of valid.get('match')||[]){if(!participantIds.has(row.participant_id!)||!mentorIds.has(row.mentor_id!)){issue('match',row.id!,'UNMAPPED_REFERENCE');continue;}
   await insert(client,'match',{id:row.id,participant_id:row.participant_id,mentor_id:row.mentor_id,score:row.score,reasons:jsonArray(row.reasons),status:row.status,origin:'legacy',enrollment_id:null,imported_at:new Date().toISOString()});
  }
  for(const name of ['email_attempt','choice_email_attempt'])for(const row of tables.get(name)||[]){if(!participantIds.has(row.participant_id!)||(name==='choice_email_attempt'&&!mentorIds.has(row.mentor_id!))){issue(name,row.participant_id!,'UNMAPPED_REFERENCE');continue;}
   await insert(client,name,{participant_id:row.participant_id,...(name==='choice_email_attempt'?{mentor_id:row.mentor_id}:{}),status:row.status,provider_id:row.provider_id??null,updated_at:timestamp(row.updated_at),updated_at_raw:row.updated_at??''});
  }
  for(const name of ['event_content','demo_seed_state'])for(const row of tables.get(name)||[])await insert(client,name,Object.fromEntries(known[name].map(col=>[col,row[col]])));
  for(const table of ['participant','mentor','match']){
   const sqliteSeq=(tables.get('sqlite_sequence')||[]).find(row=>row.name===table)?.seq||'0';
   const maximum=(await client.query(`SELECT coalesce(max(id),0)::text AS id FROM public.${quote(table)}`)).rows[0].id;
   const high=BigInt(sqliteSeq)>BigInt(maximum)?BigInt(sqliteSeq):BigInt(maximum);
   await client.query("SELECT setval(pg_get_serial_sequence($1,'id'),$2::bigint,$3)",[table,high===BigInt(0)?'1':String(high),high>BigInt(0)]);
  }
  for(const entry of issues)await insert(client,'migration_issue',{id:randomUUID(),run_id:runId,source_table:entry.table,source_key:entry.key,code:entry.code});
  report.issues=issues.length;report.status=issues.length?'pending':'imported';await client.query('UPDATE public.migration_run SET status=$2 WHERE id=$1',[runId,report.status]);
  await client.query('COMMIT');return report;
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
}
if(process.argv[1]?.endsWith('/import.ts')||process.argv[1]?.endsWith('\\import.ts')){
 const path=process.argv.find((arg,i)=>i>1&&!arg.startsWith('--'));if(!path){console.error('Uso: pnpm db:import CÓPIA --dry-run');process.exitCode=1;}
 else readSnapshot(path).then(s=>importSnapshot(s,{dryRun:process.argv.includes('--dry-run')})).then(r=>console.log(JSON.stringify(r))).catch(()=>{console.error('Importação recusada; consulte origem e destino protegidos.');process.exitCode=1;});
}
