import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { migrate } from '../../scripts/migration/migrate';
import { hashPassword, verifyPassword, tokenDigest } from '../../src/lib/db';

const base=process.env.MIGRATION_DATABASE_URL;
test('T03/T04: Backup API, dry-run, todas técnicas/bytes/IDs/FKs, colisões, idempotência e sequences',async()=>{
 assert.ok(base,'PG real obrigatório');
 const url=new URL(base);const name='tw_import_'+randomUUID().replace(/-/g,'');const control=new Pool({connectionString:base});await control.query(`CREATE DATABASE ${name}`);url.pathname='/'+name;
 const db=new Pool({connectionString:url.toString()});
 try{
  await migrate(url.toString());mkdirSync('data/fixtures',{recursive:true});
  const path=`data/fixtures/${name}.db`,backup=path+'.backup';
  const hash1=await hashPassword('synthetic-admin-one'),hash2=await hashPassword('synthetic-admin-two');
  const {snapshotBackup,readSnapshot}=await import('../../scripts/migration/source');
  const {importSnapshot}=await import('../../scripts/migration/import');
  execFileSync('python3',['-c',`
import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('pragma journal_mode=WAL');c.execute('pragma foreign_keys=ON')
c.executescript('''
CREATE TABLE participant(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,goal TEXT NOT NULL,moment TEXT NOT NULL,interests TEXT NOT NULL,skills TEXT NOT NULL,area TEXT,token_hash TEXT UNIQUE NOT NULL,consent_version TEXT NOT NULL,consent_at TEXT NOT NULL,extra_text TEXT);
CREATE TABLE mentor(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,trajectory TEXT NOT NULL,specialties TEXT NOT NULL,availability TEXT NOT NULL,capacity INTEGER NOT NULL,active INTEGER NOT NULL,demo INTEGER NOT NULL,demo_name TEXT);
CREATE TABLE match(id INTEGER PRIMARY KEY AUTOINCREMENT,participant_id INTEGER REFERENCES participant(id),mentor_id INTEGER REFERENCES mentor(id),score INTEGER,reasons TEXT,status TEXT);
CREATE TABLE admin_user(email TEXT PRIMARY KEY,password_hash TEXT,role TEXT);
CREATE TABLE email_attempt(participant_id INTEGER PRIMARY KEY REFERENCES participant(id),status TEXT,provider_id TEXT,updated_at TEXT);
CREATE TABLE choice_email_attempt(participant_id INTEGER PRIMARY KEY REFERENCES participant(id),mentor_id INTEGER REFERENCES mentor(id),status TEXT,provider_id TEXT,updated_at TEXT);
CREATE TABLE event_content(id INTEGER PRIMARY KEY,description TEXT,venue TEXT,agenda TEXT,speakers TEXT,date TEXT,duration TEXT);
CREATE TABLE demo_seed_state(id INTEGER PRIMARY KEY);
CREATE TABLE unknown_technical(id INTEGER,payload BLOB,big_id INTEGER,odd REAL);
''')
c.execute('INSERT INTO participant VALUES(?,?,?,?,?,?,?,?,?,?,?)',(41,' ADMIN@example.invalid ','growth','working','["dados"]','["analise"]','dados',sys.argv[4],'v1','','literal  whitespace  '))
c.execute('INSERT INTO participant VALUES(?,?,?,?,?,?,?,?,?,?,?)',(42,'solo@example.invalid','growth','working','["dados"]','["analise"]',None,sys.argv[5],'v1','2026-10-01T10:00:00-03:00',None))
c.execute('INSERT INTO participant VALUES(?,?,?,?,?,?,?,?,?,?,?)',(43,'SOLO@example.invalid','growth','working','["dados"]','["analise"]',None,sys.argv[6],'v1','invalid-date',None))
c.execute('INSERT INTO mentor VALUES(7,?,?,?,?,?,?,?,?)',('admin@example.invalid','Trajetória fictícia','["dados"]','texto',50,1,0,None))
c.execute('INSERT INTO match VALUES(9,41,7,9,?,?)',('["razão"]','approved'))
c.executemany('INSERT INTO admin_user VALUES(?,?,?)',[('admin@example.invalid',sys.argv[2],'owner'),(' ADMIN@example.invalid ',sys.argv[3],'owner'),('team@example.invalid',sys.argv[2],'member')])
c.execute("INSERT INTO email_attempt VALUES(41,'unknown-status','provider-literal','')")
c.execute("INSERT INTO choice_email_attempt VALUES(41,7,'ses-accepted','id-literal','2026-10-01T10:00:00Z')")
c.execute("INSERT INTO event_content VALUES(1,'Recife preservado','Recife, PE','Agenda textual','Texto','2026-11-14','')")
c.execute('INSERT INTO demo_seed_state VALUES(1)')
c.execute('INSERT INTO unknown_technical VALUES(1,?,?,?)',(bytes([0,255,0]),9223372036854775806,0.1))
c.execute("UPDATE sqlite_sequence SET seq=900 WHERE name='participant'");c.execute("UPDATE sqlite_sequence SET seq=800 WHERE name='mentor'");c.execute("UPDATE sqlite_sequence SET seq=700 WHERE name='match'")
c.commit()
# Manter conexão WAL aberta ao executar Backup API no filho.
import subprocess
subprocess.run(['python3','scripts/migration/snapshot.py','--backup',sys.argv[1],sys.argv[7]],check=True)
c.close()
`,path,hash1,hash2,tokenDigest('a'.repeat(64)),tokenDigest('b'.repeat(64)),tokenDigest('c'.repeat(64)),backup]);
  const snapshot=await readSnapshot(backup);
  const dry=await importSnapshot(snapshot,{url:url.toString(),dryRun:true});assert.equal(dry.dryRun,true);assert.equal((await db.query('select * from migration_run')).rowCount,0);
  const report=await importSnapshot(snapshot,{url:url.toString()});assert.equal(report.status,'pending');assert.ok(report.issues>0);
  const repeat=await importSnapshot(snapshot,{url:url.toString()});assert.equal(repeat.idempotent,true);
  assert.equal((await db.query('select * from migration_run')).rowCount,1);
  for(const table of snapshot.tables){
   const archive=await db.query('select cells from legacy_snapshot.source_row where run_id=$1 and table_name=$2 order by row_number',[report.runId,table.name]);
   assert.deepEqual(archive.rows.map(r=>r.cells),table.rows);
   const columns=await db.query('select columns from legacy_snapshot.source_table where run_id=$1 and name=$2',[report.runId,table.name]);assert.deepEqual(columns.rows[0].columns,table.columns);
  }
  assert.equal((await db.query('select * from participant')).rowCount,3);
  assert.equal((await db.query('select capacity from mentor where id=7')).rows[0].capacity,50);
  assert.equal((await db.query('select token_hash from participant where id=41')).rows[0].token_hash,tokenDigest('a'.repeat(64)));
  assert.equal((await db.query('select consent_at_raw from participant where id=43')).rows[0].consent_at_raw,'invalid-date');
  assert.equal((await db.query('select updated_at_raw from email_attempt')).rows[0].updated_at_raw,'');
  assert.equal((await db.query('select status from email_attempt')).rows[0].status,'unknown-status');
  assert.equal((await db.query('select origin from match')).rows[0].origin,'legacy');
  assert.equal((await db.query('select * from cohort')).rowCount,0);assert.equal((await db.query('select * from topic')).rowCount,0);
  assert.equal((await db.query("select * from app_user where email_key='admin@example.invalid'")).rowCount,0,'colisão não escolhe hash');
  const archived=await db.query("select cells from legacy_snapshot.source_row where table_name='admin_user' order by row_number");assert.equal(archived.rowCount,3);
  const team=(await db.query("select password_hash from app_user where email_key='team@example.invalid'")).rows[0];assert.equal(team.password_hash,hash1);assert.equal(await verifyPassword('synthetic-admin-one',team.password_hash),true);
  assert.equal((await db.query("select * from participant where user_id is not null")).rowCount,0,'não inferir posse');
  const resolutions=(await db.query('select resolution from migration_identity_link')).rows.map(r=>r.resolution);assert.ok(resolutions.includes('credential_conflict'));assert.ok(resolutions.includes('privileged_candidate'));
  const newParticipant=await db.query("insert into participant(email,goal,moment,interests,skills,token_hash,consent_version) values('new@example.invalid','growth','working','[]','[]',$1,'v1') returning id",[tokenDigest(randomUUID())]);assert.ok(BigInt(newParticipant.rows[0].id)>BigInt(900));
  const newMentor=await db.query("insert into mentor(email,trajectory,specialties,availability,capacity) values('new-mentor@example.invalid','texto','[]','texto',1) returning id");assert.ok(BigInt(newMentor.rows[0].id)>BigInt(800));
  const newMatch=await db.query("insert into match(participant_id,mentor_id,score,reasons,status) values($1,$2,1,'[]','rejected') returning id",[newParticipant.rows[0].id,newMentor.rows[0].id]);assert.ok(BigInt(newMatch.rows[0].id)>BigInt(700));
  const dump=`data/fixtures/${name}.dump`;execFileSync('pg_dump',['--dbname',url.toString(),'-Fc','--file',dump]);
  const restoreName=name+'_restore';await control.query(`CREATE DATABASE ${restoreName}`);const restoreUrl=new URL(url);restoreUrl.pathname='/'+restoreName;execFileSync('pg_restore',['--dbname',restoreUrl.toString(),'--no-owner','--no-acl',dump]);const restored=new Pool({connectionString:restoreUrl.toString()});
  try{for(const table of ['participant','mentor','match','email_attempt','choice_email_attempt','event_content','demo_seed_state','app_user','user_role','migration_run','migration_identity_link','migration_issue']){const source=await db.query(`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`);const target=await restored.query(`select to_jsonb(t) as row from ${table} t order by to_jsonb(t)::text`);assert.deepEqual(target.rows,source.rows);}assert.deepEqual((await restored.query('select * from legacy_snapshot.source_row order by table_name,row_number')).rows,(await db.query('select * from legacy_snapshot.source_row order by table_name,row_number')).rows);}finally{await restored.end();}
  await assert.rejects(importSnapshot({...snapshot,checksum:'f'.repeat(64)},{url:url.toString()}),/destino|vazio|isolado/i);
 }finally{await db.end();await control.end();}
});
