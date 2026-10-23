import { clearSessionCookie, csrfValid, handle, HttpError, noContent, requireOrigin, sessionTokenFromRequest } from '@/lib/auth';
import { identitySession, logout } from '@/lib/identity';
export const runtime = 'nodejs';
/** Revoga a sessão atual e limpa o cookie. Sem sessão válida é idempotente (204). */
export const POST = handle(async request => {
  requireOrigin(request);
  const token = sessionTokenFromRequest(request);
  if (token && await identitySession(token)) {
    if (!csrfValid(request, token)) throw new HttpError('CSRF_REJECTED');
    await logout(token);
  }
  return noContent({ 'Set-Cookie': clearSessionCookie() });
});
