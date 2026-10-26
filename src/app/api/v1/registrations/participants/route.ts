import { enforceRate, handle, hourlyRules, idempotencyKey, ok, publicIdempotencyScope, readJson, requireOrigin } from '@/lib/auth';
import { parseParticipantRegistration } from '@/lib/contracts';
import { registerParticipant } from '@/lib/registration';
export const runtime = 'nodejs';
/** Sempre 202 `{status:'received',next:'check_email'}`: conta nova, duplicada ou existente são indistinguíveis. */
export const POST = handle(async request => {
  requireOrigin(request);
  const body = parseParticipantRegistration(await readJson(request));
  const key = idempotencyKey(request);
  await enforceRate(hourlyRules('register-participant', request, body.email));
  return ok(await registerParticipant(body, { key, scope: publicIdempotencyScope('participant', request, body.email) }), 202);
});
