import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {Pool} from 'pg';
import {migrate} from '../../scripts/migration/migrate';
import {seedDemo} from '../../scripts/seed-demo';
import {getDb,closeDb} from '../../src/lib/db';
import {createParticipant,publicSuggestions,reserve,stateFor,authenticate} from '../../src/lib/service';

test('R2: credenciais migrador/runtime/mailer separadas, fluxo PG com grants locais mínimos',async()=>{
 const base=process.env.MIGRATION_DATABASE_URL;assert.ok(base);const control=new Pool({connectionString:base});
 const prefix='wp1_'+randomUUID().replace(/-/g,'');const names={migrator:prefix+'_m',runtime:prefix+'_r',mailer:prefix+'_e'};const password=randomBytes(24).toString('hex');const database=prefix+'_db';
 for(const name of Object.values(names)){const {rows}=await control.query("select format('CREATE ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',$1::text,$2::text) as command",[name,password]);await control.query(rows[0].command);}
 await control.query(`CREATE DATABASE ${database} OWNER ${names.migrator}`);
 const urls=Object.fromEntries(Object.entries(names).map(([kind,name])=>{const url=new URL(base);url.pathname='/'+database;url.username=name;url.password=password;return [kind,url.toString()];}));
 await migrate(urls.migrator);const migrator=new Pool({connectionString:urls.migrator}),runtime=new Pool({connectionString:urls.runtime}),mailer=new Pool({connectionString:urls.mailer});
 try{
  const grants=readFileSync('scripts/migration/grants-local.sql','utf8').replaceAll('techwoman_runtime',names.runtime).replaceAll('techwoman_mailer',names.mailer);await migrator.query(grants);
  process.env.DATABASE_URL=urls.migrator;process.env.ADMIN_EMAIL='admin-roles@example.invalid';process.env.ADMIN_PASSWORD=randomBytes(24).toString('base64url');await seedDemo();await closeDb();
  process.env.DATABASE_URL=urls.runtime;
  assert.equal((await authenticate(process.env.ADMIN_EMAIL,process.env.ADMIN_PASSWORD))?.role,'owner');
  const created=await createParticipant({email:'roles-flow@example.invalid',goal:'growth',moment:'working',interests:['dados'],skills:['analise'],area:'dados',consent:true});const choices=await publicSuggestions(created.token);assert.ok(choices.choices.length>0);await reserve(created.token,choices.choices[0].mentorId);assert.equal((await stateFor(created.token))?.status,'Mentoria reservada');
  await assert.rejects(runtime.query('create table public.forbidden_runtime(id int)'),error=>!!error&&typeof error==='object'&&'code' in error&&error.code==='42501');
  for(const query of ['select * from legacy_snapshot.source_row','select * from migration_identity_link','select * from migration_issue','select * from internal.schema_migration'])await assert.rejects(runtime.query(query));
  await assert.rejects(mailer.query('select password_hash from app_user'));await mailer.query('select * from email_job');
 }finally{await closeDb();await migrator.end();await runtime.end();await mailer.end();await control.end();}
});

test('R2: composição local não passa .env ou credencial migradora ao web',()=>{
 const value=randomBytes(24).toString('hex');const env={...process.env,POSTGRES_PASSWORD:value,MIGRATOR_PASSWORD:value,RUNTIME_PASSWORD:value,MAILER_PASSWORD:value,ADMIN_EMAIL:'admin-local@example.invalid',ADMIN_PASSWORD:value,SESSION_SECRET:randomBytes(48).toString('hex')};
 const compose=JSON.parse(execFileSync('docker',['compose','config','--format','json'],{encoding:'utf8',env}));
 assert.equal(compose.services.postgres.image,'postgres:16-bookworm');assert.equal(compose.services.postgres.ports[0].host_ip,'127.0.0.1');
 assert.equal(compose.services.app.environment.MIGRATION_DATABASE_URL,undefined);assert.equal(compose.services.app.environment.ADMIN_PASSWORD,undefined);assert.equal(compose.services.app.environment.POSTGRES_PASSWORD,undefined);
 assert.match(compose.services.app.environment.DATABASE_URL,/techwoman_runtime/);assert.match(compose.services.migrate.environment.MIGRATION_DATABASE_URL,/techwoman_migrator/);
 assert.equal(compose.services.app.environment.SES_SEND_ENABLED,'0');assert.equal(compose.services.app.environment.EMAIL_MODE,'fake');assert.equal(compose.services.app.env_file,undefined);
 const docker=readFileSync('Dockerfile','utf8');for(const path of ['/app/scripts /tools/scripts','/app/drizzle /tools/drizzle','/app/src/lib /tools/src/lib','/app/node_modules /tools/node_modules'])assert.ok(docker.includes(path));
});
