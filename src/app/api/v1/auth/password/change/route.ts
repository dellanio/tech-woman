import { handle, ok, readJson, requireSession, sessionCookieFor } from '@/lib/auth';
import { parsePasswordChange } from '@/lib/contracts';
import { changePassword } from '@/lib/identity';
export const runtime = 'nodejs';
/** Sessão limitada ou full + CSRF. Grava a senha definitiva, revoga tudo e devolve uma nova sessão full no cookie. */
export const POST = handle(async request => {
  const { token } = await requireSession(request, { mutation: true, full: false });
  const { currentPassword, newPassword } = parsePasswordChange(await readJson(request));
  const next = await changePassword(token, currentPassword, newPassword);
  return ok({ state: 'authenticated' }, 200, { 'Set-Cookie': sessionCookieFor(next.token, 'authenticated') });
});
