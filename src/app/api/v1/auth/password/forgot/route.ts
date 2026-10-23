import { enforceRate, handle, hourlyRules, ok, readJson, requireOrigin } from '@/lib/auth';
import { parsePasswordForgot } from '@/lib/contracts';
import { requestPasswordForgot } from '@/lib/identity';
export const runtime = 'nodejs';
/** 202 idêntico para conta inexistente, desativada, pendente, ativa ou admin; limitado por e-mail+ação e IP. */
export const POST = handle(async request => {
  requireOrigin(request);
  const { email } = parsePasswordForgot(await readJson(request));
  await enforceRate(hourlyRules('forgot', request, email));
  return ok(await requestPasswordForgot(email), 202);
});
