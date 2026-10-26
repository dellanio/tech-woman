import { assertOk, resendTemporary } from '@/lib/accounts';
import { handleWith, idempotencyKey, ok, readJson, requireSession } from '@/lib/auth';
import { parseTemporaryPasswordRequest } from '@/lib/contracts';
export const runtime = 'nodejs';
/** Enfileira nova senha temporária (intenção sem segredo). 202 `{jobId,status:'queued'}`; nunca devolve senha. */
export const POST = handleWith<{ id: string }>(async (request, { id }) => {
  const { token } = await requireSession(request, { mutation: true, roles: ['admin'], visibleTo: ['admin', 'team'] });
  parseTemporaryPasswordRequest(await readJson(request));
  const result = assertOk(await resendTemporary(token, id, idempotencyKey(request)));
  return ok(result.job, 202);
});
