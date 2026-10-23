import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {withDb,addParticipant,mentorWithCohort,applyLocalGrants} from './agenda-harness';
import {closeEmailPool,runEmailWorkerOnce,createMemoryTransport,TransportError,type EmailMessage} from '../../src/lib/email';
import {roleUrl} from './identity-harness.test';

const snapshot=async(db:import('pg').Pool)=>JSON.stringify((await db.query('select id,password_hash,temporary_password_hash,credential_generation,session_version,must_change_password,status from app_user order by id')).rows);
async function scenario(fn:(db:import('pg').Pool,p:string,e:string)=>Promise<void>){
 await withDb(async({db,url})=>{
  await applyLocalGrants(db); const p=await addParticipant(db); const c=await mentorWithCohort(db);
  const e=String((await db.query("insert into enrollment(participant_id,cohort_id,status) values($1,$2,'active') returning id",[p,c.cohort])).rows[0].id);
  const saved=process.env.MAILER_DATABASE_URL; await closeEmailPool();process.env.MAILER_DATABASE_URL=roleUrl(url,'techwoman_mailer');
  try{await fn(db,p,e);}finally{await closeEmailPool();if(saved===undefined)delete process.env.MAILER_DATABASE_URL;else process.env.MAILER_DATABASE_URL=saved;}
 });
}
test('INT-003: reserva fake é confirmação sem senha/token nem alteração de identidade; retry seguro',async()=>scenario(async(db,_p,e)=>{
 const before=await snapshot(db); const seen:EmailMessage[]=[];
 const first=await runEmailWorkerOnce(createMemoryTransport(m=>{seen.push(m);throw new TransportError('TRANSPORT_TIMEOUT');}));
 assert.equal(first.unconfirmed,1);assert.equal(seen.length,1);assert.equal(String(seen[0].kind),'reservation');assert.equal(seen[0].secret,'');
 assert.match(seen[0].subject,/reserva/i);assert.match(seen[0].text,/America\/Recife/);assert.doesNotMatch(seen[0].text,/senha|redefinição|temporári/i);
 assert.equal(await snapshot(db),before);assert.equal((await db.query('select count(*)::int n from password_reset_token')).rows[0].n,0);
 await db.query("update email_job set next_attempt_at=now()-interval '1 second' where enrollment_id=$1",[e]);
 const second=await runEmailWorkerOnce(createMemoryTransport(m=>{seen.push(m);}));assert.equal(second.simulated,1);assert.equal(seen.length,2);assert.equal(seen[1].secret,'');assert.equal(await snapshot(db),before);
 assert.equal((await db.query('select status from email_job where enrollment_id=$1',[e])).rows[0].status,'simulated');
 assert.equal((await db.query('select count(*)::int n from email_delivery_attempt')).rows[0].n,2);
}));
test('INT-003: cancelamento entre tentativas impede confirmação de reserva obsoleta',async()=>scenario(async(db,_p,e)=>{
 await runEmailWorkerOnce(createMemoryTransport(()=>{throw new TransportError('TRANSPORT_TIMEOUT');}));
 await db.query("update enrollment set status='cancelled' where id=$1",[e]);
 let sent=0;const result=await runEmailWorkerOnce(createMemoryTransport(()=>{sent++;}));assert.equal(sent,0);assert.equal(result.claimed,0);
 assert.equal((await db.query('select status from email_job where enrollment_id=$1',[e])).rows[0].status,'cancelled');
}));
test('INT-003: job reserva forjado sem vínculo elegível é cancelado sem tocar credenciais',async()=>scenario(async(db,p,e)=>{
 await db.query("update email_job set status='cancelled' where enrollment_id=$1",[e]);
 const uid=(await db.query('select user_id from participant where id=$1',[p])).rows[0].user_id;
 await db.query("insert into email_job(id,user_id,kind,generation,status,dedupe_key) values($1,$2,'reservation',0,'queued',$1::text)",[randomUUID(),uid]);
 const before=await snapshot(db);let sent=0;const result=await runEmailWorkerOnce(createMemoryTransport(()=>{sent++;}));assert.equal(result.cancelled,1);assert.equal(sent,0);assert.equal(await snapshot(db),before);
}));
