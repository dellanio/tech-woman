import { assertOk, disableAccount, getAccount, updateAccount } from '@/lib/accounts';
import { etag, handle, ifMatch, ok, readJson, requireSession } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { id: string };
/** Protegido (admin/team/privilegiado, mesmo multi-perfil) e inexistente respondem 404 idêntico. */
export const GET = handle<Params>(async (request, { id }) => {
  const { token } = await requireSession(request, { roles: ['admin', 'team'] });
  const result = assertOk(await getAccount(token, id));
  return ok(result.user, 200, etag(String(result.user?.version)));
});
export const PATCH = handle<Params>(async (request, { id }) => {
  const { token } = await requireSession(request, { mutation: true, roles: ['admin'] });
  const version = ifMatch(request);
  const result = assertOk(await updateAccount(token, id, version, await readJson(request)));
  return ok(result.user, 200, etag(String(result.user?.version)));
});
/** DELETE = desativar (sessões revogadas, jobs cancelados), sem apagar domínio nem histórico. */
export const DELETE = handle<Params>(async (request, { id }) => {
  const { token } = await requireSession(request, { mutation: true, roles: ['admin'] });
  const result = assertOk(await disableAccount(token, id, ifMatch(request)));
  return ok(result.user, 200, etag(String(result.user?.version)));
});
