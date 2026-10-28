import { enforceRate, handle, hourlyRules, idempotencyKey, ok, publicIdempotencyScope, readJson, requireOrigin } from '@/lib/auth';
import { parseParticipantSignup } from '@/lib/contracts';
import { registerParticipant } from '@/lib/registration';
export const runtime = 'nodejs';
/**
 * Última etapa do cadastro (depois do crossing): diagnóstico + mentor_ref + e-mail + senha definitiva + confirmação.
 * Sempre 202 `{status:'received',next:'login'}`: conta nova, duplicada ou existente são indistinguíveis. Nenhum e-mail é enfileirado.
 */
export const POST = handle(async request => {
  requireOrigin(request);
  const body = parseParticipantSignup(await readJson(request));
  const key = idempotencyKey(request);
  await enforceRate(hourlyRules('register-participant', request, body.email));
  return ok(await registerParticipant(body, { key, scope: publicIdempotencyScope('participant', request, body.email) }), 202);
});
