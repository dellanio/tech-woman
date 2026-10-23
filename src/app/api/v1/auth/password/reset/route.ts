import { clearSessionCookie, enforceRate, handle, noContent, readJson, requireOrigin, resetRules } from '@/lib/auth';
import { parsePasswordReset } from '@/lib/contracts';
import { confirmPasswordReset } from '@/lib/identity';
export const runtime = 'nodejs';
/** Token inválido, usado ou vencido → 400 INVALID_RESET; sucesso → 204 (sessões revogadas, exige login novo). */
export const POST = handle(async request => {
  requireOrigin(request);
  const { token, newPassword } = parsePasswordReset(await readJson(request));
  await enforceRate(resetRules(request));
  await confirmPasswordReset(token, newPassword);
  return noContent({ 'Set-Cookie': clearSessionCookie() });
});
