import { csrfToken, handle, ok, requireSession } from '@/lib/auth';
export const runtime = 'nodejs';
/** Token CSRF ligado (HMAC) à sessão atual, inclusive a limitada de troca de senha. */
export const GET = handle(async request => {
  const { token } = await requireSession(request, { full: false });
  return ok({ csrfToken: csrfToken(token) });
});
