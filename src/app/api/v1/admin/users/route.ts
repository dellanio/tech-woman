import { assertOk, createAccount, listAccounts } from '@/lib/accounts';
import { etag, handle, idempotencyKey, ok, okCollection, readJson, requireSession } from '@/lib/auth';
export const runtime = 'nodejs';
/** GET: admin e team (leitura). Protegidos nunca entram na coleção; cursor opaco e ordem estável por id. */
export const GET = handle(async request => {
  const { token } = await requireSession(request, { roles: ['admin', 'team'] });
  const query = new URL(request.url).searchParams;
  const limit = query.get('limit');
  const result = assertOk(await listAccounts(token, { limit: limit === null ? undefined : Number(limit), cursor: query.get('cursor') }));
  return okCollection(result.users ?? [], result.nextCursor ?? null);
});
/** POST: só admin, Idempotency-Key obrigatório; `roles` deve ser exatamente os domínios enviados (sem usuário órfão, sem admin/team). */
export const POST = handle(async request => {
  const { token } = await requireSession(request, { mutation: true, roles: ['admin'] });
  const body = await readJson(request);
  const result = assertOk(await createAccount(token, idempotencyKey(request), body));
  return ok(result.user, 201, etag(String(result.user?.version)));
});
