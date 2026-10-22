import { Pool } from 'pg';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

export async function migrate(url=process.env.MIGRATION_DATABASE_URL){
 if(!url) throw new Error('MIGRATION_DATABASE_URL é obrigatória, nunca usar a credencial web.');
 const pool=new Pool({connectionString:url,max:1});const client=await pool.connect();
 try {
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock(741001)');
  await client.query('CREATE SCHEMA IF NOT EXISTS internal');
  await client.query('REVOKE ALL ON SCHEMA internal FROM PUBLIC');
  await client.query('CREATE TABLE IF NOT EXISTS internal.schema_migration(name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())');
  for(const name of (await readdir(resolve('drizzle'))).filter(f=>f.endsWith('.sql')).sort()){
   const source=await readFile(resolve('drizzle',name),'utf8');const checksum=createHash('sha256').update(source.replace(/\r\n/g,'\n')).digest('hex');
   const old=await client.query('SELECT checksum FROM internal.schema_migration WHERE name=$1',[name]);
   if(old.rowCount){if(old.rows[0].checksum!==checksum) throw new Error('Migration aplicada diverge da versão registrada.');continue;}
   await client.query(source);await client.query('INSERT INTO internal.schema_migration(name,checksum) VALUES($1,$2)',[name,checksum]);
  }
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();await pool.end();}
}
if(process.argv[1]?.endsWith('/migrate.ts')||process.argv[1]?.endsWith('\\migrate.ts')) migrate().then(()=>console.log('Migrations aplicadas.')).catch(()=>{console.error('Falha na migration; nenhuma alteração parcial.');process.exitCode=1;});
