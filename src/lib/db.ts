import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import * as schema from './schema';
import { logPoolErrors } from './pool-errors';
export * from './schema';

let pool: Pool | undefined;
let database: NodePgDatabase<typeof schema> | undefined;
/** Construir/importar este módulo não abre sockets. Só a primeira consulta usa o pool. */
export function getDb() {
  if (!database) {
    const connectionString=process.env.DATABASE_URL;
    if(!connectionString) throw new Error('Configure DATABASE_URL para PostgreSQL.');
    // Margem para cold start em host compartilhado; aquisição continua limitada a 10 s (FIX-T01).
    pool=logPoolErrors(new Pool({connectionString,max:5,connectionTimeoutMillis:10000,idleTimeoutMillis:10000,statement_timeout:15000,lock_timeout:5000,idle_in_transaction_session_timeout:15000}),'web');
    database=drizzle(pool,{schema});
  }
  return database;
}
export async function closeDb(){ if(pool) await pool.end(); pool=undefined; database=undefined; }
export const tokenDigest=(token:string)=>createHash('sha256').update(token).digest('hex');
export const newToken=()=>randomBytes(32).toString('hex');
const derive=(password:string,salt:string)=>new Promise<Buffer>((resolve,reject)=>scrypt(password,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024},(error,key)=>error?reject(error):resolve(key)));
export async function hashPassword(password:string){ const salt=randomBytes(16).toString('hex');return `${salt}:${(await derive(password,salt)).toString('hex')}`; }
export async function verifyPassword(password:string,stored:string){ if(!/^[a-f0-9]{32}:[a-f0-9]{128}$/.test(stored)) return false;const [salt,digest]=stored.split(':');return timingSafeEqual(await derive(password,salt),Buffer.from(digest,'hex')); }
