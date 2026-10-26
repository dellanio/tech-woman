import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Pool} from 'pg';
import {randomUUID} from 'node:crypto';
import {migrate} from '../../scripts/migration/migrate';
test('DER v1: FKs RESTRICT, posições deferíveis, migration vazia sem seed e próxima ID 1',async()=>{
 const base=process.env.MIGRATION_DATABASE_URL;assert.ok(base);const control=new Pool({connectionString:base});const name='tw_schema_'+randomUUID().replace(/-/g,'');await control.query(`create database ${name}`);const url=new URL(base);url.pathname='/'+name;const db=new Pool({connectionString:url.toString()});
 try{
  await migrate(url.toString());await migrate(url.toString());
  const fks=await db.query("select constraint_name,delete_rule from information_schema.referential_constraints where constraint_schema in ('public','legacy_snapshot')");assert.ok(fks.rows.length>20);for(const fk of fks.rows)assert.equal(fk.delete_rule,'RESTRICT',fk.constraint_name);
  const unique=await db.query("select condeferrable,condeferred from pg_constraint where conname='mentor_topic_position_unique'");assert.deepEqual(unique.rows,[{condeferrable:true,condeferred:false}]);
  for(const table of ['participant','mentor','topic','cohort','demo_seed_state','event_content'])assert.equal((await db.query(`select * from ${table}`)).rowCount,0,table+' não recebe seed implícito');
  const p=await db.query("insert into participant(email,goal,moment,interests,skills,token_hash,consent_version) values('schema@example.invalid','growth','working','[]','[]','synthetic-token-hash','v1') returning id,version");assert.equal(p.rows[0].id,'1');assert.equal(p.rows[0].version,'1');
  const updated=await db.query("update participant set area='dados' where id=1 returning version");assert.equal(updated.rows[0].version,'2');
  await assert.rejects(db.query("insert into participant(email,goal,moment,interests,skills,token_hash,consent_version) values('x@example.invalid','growth','working','{}','[]','synthetic-invalid-hash','v1')"));
 }finally{await db.end();await control.end();}
});
