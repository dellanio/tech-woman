// Elevação offline de contas (WP-002 Task 3): somente operador, via credencial de migração, nunca por HTTP.
// Uso: MIGRATION_DATABASE_URL=... tsx scripts/privileged-account.ts <grant-admin|revoke-admin|grant-team|revoke-team> --user-id <uuid> --confirm
// Identifica a conta SÓ pelo UUID (sem busca/inferência por e-mail), usa o mesmo lock de app_user do CRUD e imprime apenas ok/código de erro.
import { Pool } from 'pg';

export type PrivilegedResult = { code: string };
type Env = Record<string, string | undefined>;
const COMMANDS: Record<string, { role: 'admin' | 'team'; grant: boolean }> = {
  'grant-admin': { role: 'admin', grant: true }, 'revoke-admin': { role: 'admin', grant: false },
  'grant-team': { role: 'team', grant: true }, 'revoke-team': { role: 'team', grant: false },
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseArgs(argv: string[]): { command: string; userId: string; confirm: boolean } | null {
  const [command, ...rest] = argv;
  if (!command || !(command in COMMANDS)) return null;
  let userId: string | null = null, confirm = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--confirm' && !confirm) confirm = true;
    else if (rest[i] === '--user-id' && userId === null && i + 1 < rest.length) userId = rest[++i];
    else return null;
  }
  return userId === null ? null : { command, userId, confirm };
}

/** `afterLock` (testes): chamado com o lock do usuário já adquirido e as verificações feitas, antes de qualquer escrita. */
export async function runPrivilegedAccount(argv: string[], env: Env, options: { afterLock?: () => Promise<void> } = {}): Promise<PrivilegedResult> {
  const args = parseArgs(argv);
  if (!args) return { code: 'USAGE' };
  const url = env.MIGRATION_DATABASE_URL;
  if (!url) return { code: 'MIGRATION_DATABASE_URL_REQUIRED' };
  if (!args.confirm) return { code: 'CONFIRM_REQUIRED' };
  if (!UUID.test(args.userId)) return { code: 'INVALID_USER_ID' };
  const { role, grant } = COMMANDS[args.command];
  const userId = args.userId.toLowerCase();
  const pool = new Pool({ connectionString: url, max: 1, connectionTimeoutMillis: 5000, statement_timeout: 30000, lock_timeout: 15000, idle_in_transaction_session_timeout: 30000 });
  let client;
  try { client = await pool.connect(); } catch { await pool.end().catch(() => undefined); return { code: 'DATABASE_UNAVAILABLE' }; }
  try {
    await client.query('BEGIN');
    // Mesmo lock do CRUD administrativo: a linha de app_user.
    const user = (await client.query('SELECT status, email_key FROM public.app_user WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    const refuse = async (code: string) => { await client.query('ROLLBACK'); return { code }; };
    if (!user) return await refuse('USER_NOT_FOUND');
    if (user.status === 'disabled') return await refuse('USER_DISABLED');
    if (grant && user.status !== 'active') return await refuse('USER_NOT_ACTIVE');
    if ((await client.query('SELECT internal.collision_unresolved($1) AS blocked', [user.email_key])).rows[0].blocked === true) return await refuse('COLLISION_UNRESOLVED');
    if (!grant && role === 'admin') {
      // Serializa revogações de admin diferentes para nunca zerar os administradores.
      await client.query('SELECT pg_advisory_xact_lock(741010)');
      const others = (await client.query(`SELECT count(*)::int AS n FROM public.user_role r JOIN public.app_user u ON u.id = r.user_id WHERE r.role = 'admin' AND u.status = 'active' AND u.id <> $1`, [userId])).rows[0].n;
      const holds = (await client.query(`SELECT 1 FROM public.user_role WHERE user_id = $1 AND role = 'admin'`, [userId])).rowCount;
      if (holds && others === 0) return await refuse('LAST_ADMIN');
    }
    await options.afterLock?.();
    const changed = grant
      ? (await client.query('INSERT INTO public.user_role(user_id, role) VALUES ($1, $2) ON CONFLICT DO NOTHING', [userId, role])).rowCount
      : (await client.query('DELETE FROM public.user_role WHERE user_id = $1 AND role = $2', [userId, role])).rowCount;
    if (changed) {
      await client.query('UPDATE public.app_user SET session_version = session_version + 1 WHERE id = $1', [userId]);
      await client.query('UPDATE public.auth_session SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await client.query(`SELECT internal.cancel_identity_jobs($1::uuid, ARRAY['registration','temporary_password','password_reset'], ARRAY['queued','sending','unconfirmed'])`, [userId]);
      await client.query(`INSERT INTO public.audit_event(actor_user_id, action, entity_type, entity_id, changed_fields, result, request_id) VALUES (NULL, $1, 'user', $2, '["role"]'::jsonb, 'ok', gen_random_uuid())`, [`privileged.${args.command.replace('-', '_')}`, userId]);
    }
    await client.query('COMMIT');
    return { code: 'ok' };
  } catch {
    await client.query('ROLLBACK').catch(() => undefined);
    return { code: 'INTERNAL_ERROR' };
  } finally { client.release(); await pool.end().catch(() => undefined); }
}

if (process.argv[1]?.endsWith('privileged-account.ts')) {
  runPrivilegedAccount(process.argv.slice(2), process.env).then(result => {
    if (result.code === 'ok') console.log('ok'); else { console.error(result.code); process.exitCode = 1; }
  });
}
