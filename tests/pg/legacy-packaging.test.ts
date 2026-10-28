import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {Pool} from 'pg';
import {withDb,roleUrl} from './identity-harness.test';
import {registerParticipant} from '../../src/lib/registration';
import {runEmailWorkerOnce,createMemoryTransport} from '../../src/lib/email';
import {login,changePassword} from '../../src/lib/identity';
import {previewCrossing} from '../../src/lib/crossing';
import {pendingParticipant} from './pending-participant';

// Contrato WP-002 substitui cadastro com token público e reserva sem horário.
// Aplica o MESMO grants-local.sql executado por LOCAL_ROLE_SETUP depois das migrations.
test('R2: grants locais preservam identidade/worker, sem SELECT de hashes nem DML livre na fila',async()=>withDb(async({db,url})=>{
 await db.query(readFileSync('scripts/migration/grants-local.sql','utf8'));
 const runtime=new Pool({connectionString:roleUrl(url,'techwoman_runtime')}),mailer=new Pool({connectionString:roleUrl(url,'techwoman_mailer')});
 try{
  for(const role of ['techwoman_runtime','techwoman_mailer'])assert.equal((await db.query("select has_schema_privilege($1,'internal','USAGE') ok",[role])).rows[0].ok,true);
  for(const q of ['select password_hash from app_user','select * from auth_session','select * from legacy_snapshot.source_row','select * from migration_identity_link','create table public.forbidden_runtime(id int)'])await assert.rejects(runtime.query(q));
  for(const q of ['select * from email_job','select * from app_user','update email_job set attempts=0','select * from email_delivery_attempt'])await assert.rejects(mailer.query(q));
  await assert.rejects(runtime.query('update email_job set attempts=0'));
  // cadastro atual: crossing + senha definitiva sob os grants locais → login full direto, sem fila
  await db.query(`insert into mentor(email,trajectory,specialties,availability,capacity,display_name) values('m-pack@example.invalid','t','["dados"]','a',2,'Mentora Pack')`);
  const profile={goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados'};const [choice]=await previewCrossing(profile);
  const definitive=randomBytes(18).toString('base64url');
  assert.deepEqual(await registerParticipant({email:'definitiva@example.invalid',...profile,consent:true,mentor_ref:choice.mentor_ref,password:definitive,passwordConfirmation:definitive},{key:randomUUID(),scope:'int002-packaging'}),{status:'received',next:'login'});
  assert.equal((await login('definitiva@example.invalid',definitive))?.state,'authenticated');
  assert.equal((await db.query('select count(*)::int n from email_job')).rows[0].n,0);
  // conta pendente legada: o worker continua emitindo o temporário sob os grants locais
  assert.ok(await pendingParticipant(db,'packaging@example.invalid'));
  let temporary='';const delivered=await runEmailWorkerOnce(createMemoryTransport(m=>{temporary=m.secret;}));assert.equal(delivered.claimed,1);assert.ok(temporary);
  const limited=await login('packaging@example.invalid',temporary);assert.equal(limited?.state,'password_change_required');assert.ok(limited);
  const full=await changePassword(limited.token,temporary,randomBytes(24).toString('base64url'));assert.ok(full.token);
  assert.equal((await db.query("select status from email_job")).rows[0].status,'simulated');
 }finally{await runtime.end();await mailer.end();}
}));

test('R2: composição local não passa .env ou credencial migradora ao web',()=>{
 const value=randomBytes(24).toString('hex');const env={...process.env,POSTGRES_PASSWORD:value,MIGRATOR_PASSWORD:value,RUNTIME_PASSWORD:value,MAILER_PASSWORD:value,ADMIN_EMAIL:'admin-local@example.invalid',ADMIN_PASSWORD:value,SESSION_SECRET:randomBytes(48).toString('hex')};
 const compose=JSON.parse(execFileSync('docker',['compose','config','--format','json'],{encoding:'utf8',env}));
 assert.equal(compose.services.postgres.image,'postgres:16-bookworm');assert.equal(compose.services.postgres.ports[0].host_ip,'127.0.0.1');
 for(const key of ['MIGRATION_DATABASE_URL','ADMIN_PASSWORD','POSTGRES_PASSWORD'])assert.equal(compose.services.app.environment[key],undefined);
 assert.match(compose.services.app.environment.DATABASE_URL,/techwoman_runtime/);assert.match(compose.services.migrate.environment.MIGRATION_DATABASE_URL,/techwoman_migrator/);
 assert.equal(compose.services.app.environment.SES_SEND_ENABLED,'0');assert.equal(compose.services.app.environment.EMAIL_MODE,'fake');assert.equal(compose.services.app.env_file,undefined);
 const docker=readFileSync('Dockerfile','utf8');for(const path of ['/app/scripts /tools/scripts','/app/drizzle /tools/drizzle','/app/src/lib /tools/src/lib','/tools/node_modules /tools/node_modules'])assert.ok(docker.includes(path));
});
