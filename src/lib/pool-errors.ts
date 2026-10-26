import type { Pool } from 'pg';

export type PoolComponent = 'web' | 'mailer';
/** SQLSTATE (57P01) ou código de socket do Node (ECONNRESET); qualquer outra coisa vira UNKNOWN. */
const SAFE_CODE = /^[A-Z0-9_]{1,40}$/;
export function safeErrorCode(error: unknown): string {
  const code = error && typeof error === 'object' ? Reflect.get(error, 'code') : undefined;
  return typeof code === 'string' && SAFE_CODE.test(code) ? code : 'UNKNOWN';
}
/**
 * Erro em conexão ociosa (backend terminado, reinício do PG, rede): sem listener o EventEmitter lança e derruba o processo.
 * O pg-pool já descarta o cliente quebrado; a próxima consulta abre conexão nova. Nada é repetido aqui.
 * Log só com componente e código: mensagem do PG, stack e connectionString nunca saem.
 */
export function logPoolErrors(pool: Pool, component: PoolComponent): Pool {
  pool.on('error', error => { console.error(JSON.stringify({ event: 'pg_pool_idle_error', component, code: safeErrorCode(error) })); });
  return pool;
}
