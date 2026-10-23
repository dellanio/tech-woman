import { enforceRate, handle, HttpError, loginRules, ok, readJson, requireOrigin, sessionCookieFor } from '@/lib/auth';
import { parseLogin } from '@/lib/contracts';
import { login } from '@/lib/identity';
export const runtime = 'nodejs';
/** 200 `{state}` + cookie opaco tw_session; credencial errada, vencida ou conta desativada → 401 genérico. */
export const POST = handle(async request => {
  requireOrigin(request);
  const { email, password } = parseLogin(await readJson(request));
  await enforceRate(loginRules(request, email));
  const result = await login(email, password);
  if (!result) throw new HttpError('INVALID_CREDENTIALS');
  return ok({ state: result.state }, 200, { 'Set-Cookie': sessionCookieFor(result.token, result.state) });
});
