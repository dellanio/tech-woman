import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const input = {email:'participant-flow@example.invalid'};
test('T01/T02: runtime exclusivamente PG, fluxo legado completo assíncrono e schema v1', async () => {
  const sources = (dir:string):string[] => readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?sources(join(dir,e.name)):[join(dir,e.name)]);
  for (const file of sources('src').filter(f=>/\.[tj]sx?$/.test(f))) assert.doesNotMatch(readFileSync(file,'utf8'), /better-sqlite3|sqlite-core|sqlite\.prepare/,file);
  const {getDb,closeDb,hashPassword,verifyPassword} = await import('../../src/lib/db');
  const {migrate} = await import('../../scripts/migration/migrate');
  const {seedDemo} = await import('../../scripts/seed-demo');
  const {Pool}=await import('pg');const {randomUUID}=await import('node:crypto');
  const base=process.env.MIGRATION_DATABASE_URL;assert.ok(base,'PG16 real obrigatório');const control=new Pool({connectionString:base});const name='tw_flow_'+randomUUID().replace(/-/g,'');await control.query(`create database ${name}`);await control.end();const url=new URL(base);url.pathname='/'+name;process.env.DATABASE_URL=url.toString();
  await migrate(url.toString());
  const db=getDb();
  const {sql}=await import('drizzle-orm');
  assert.match(String((await db.execute(sql`select version()`)).rows[0].version),/PostgreSQL 16\./);
  await seedDemo();
  const service=await import('../../src/lib/service');
  // Contrato final (CONTRATOS §7, linhas 111/114–115): cadastro antigo com token/protocolo virou o 202 v1; o link legado só lê histórico pelo hash
  // e a escolha por token não cria mais match (409 de reconciliação). Fixture legada gravada como dono do banco, como o importador.
  const {randomBytes}=await import('node:crypto');const {tokenDigest}=await import('../../src/lib/db');const {HttpError}=await import('../../src/lib/auth');
  const token=randomBytes(32).toString('hex');
  const [legacy]=(await db.execute(sql`insert into participant(email,goal,moment,interests,skills,area,token_hash,consent_version) values(${input.email},'growth','working','["dados"]','["analise"]','dados',${tokenDigest(token)},'v0') returning id`)).rows;
  await db.execute(sql`insert into email_attempt(participant_id,status,updated_at) values(${String(legacy.id)},'mock-not-sent',now())`);
  const state=await service.stateFor(token);
  assert.match(String(state?.protocol),/^TW-/);
  assert.match(String(state?.emailStatus),/NÃO ENVIADA/);
  assert.equal(state?.status,'Aguardando escolha ou revisão da equipe');
  const choices=await service.legacyChoices(token);
  assert.deepEqual([choices.choices,choices.next],[[],'activate_account']);
  await assert.rejects(service.legacyChoose(token,{mentorId:'1'}),(e:unknown)=>e instanceof HttpError&&e.code==='IDENTITY_RECONCILIATION_REQUIRED');
  assert.equal(String((await db.execute(sql`select count(*)::int n from match`)).rows[0].n),'0','nenhum match criado por token');
  const {newSessionToken}=await import('../../src/lib/identity');const session=newSessionToken();const adminId=randomUUID();
  await db.execute(sql`insert into app_user(id,email,status) values(${adminId}::uuid,'admin-flow@example.invalid','active')`);await db.execute(sql`insert into user_role(user_id,role) values(${adminId}::uuid,'admin')`);
  await db.execute(sql`insert into auth_session(id,user_id,token_hash,scope,session_version,expires_at) values(gen_random_uuid(),${adminId}::uuid,${tokenDigest(session)},'full',0,now()+interval '1 hour')`);
  assert.ok((await service.adminOverview(session)).participants.some(p=>p.protocol===state?.protocol),'overview com sessão admin nova');
  const {scryptSync}=await import('node:crypto');const salt='0123456789abcdef0123456789abcdef';const legacyHash=salt+':'+scryptSync('legacy-fixture-only',salt,64).toString('hex');
  assert.equal(await verifyPassword('legacy-fixture-only',legacyHash),true,'salt hex como string UTF-8, não bytes decodificados');
  assert.equal(await verifyPassword('wrong',legacyHash),false);
  const hash=await hashPassword('synthetic-password-only');
  assert.equal(await verifyPassword('synthetic-password-only',hash),true);
  assert.equal(await verifyPassword('wrong',hash),false);
  const tables=(await db.execute(sql`select table_name from information_schema.tables where table_schema='public'`)).rows.map(r=>r.table_name);
  for(const table of ['app_user','user_role','participant','mentor','match','topic','mentor_topic','cohort','enrollment','auth_session','password_reset_token','email_job','email_delivery_attempt','email_attempt','choice_email_attempt','event_content','demo_seed_state','audit_event','api_idempotency','auth_rate_bucket','migration_run','migration_identity_link','migration_issue']) assert.ok(tables.includes(table),table);
  await closeDb();
});
