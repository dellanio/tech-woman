import { enforceRate, handle, hourlyRules, idempotencyKey, ok, publicIdempotencyScope, readJson, requireOrigin } from '@/lib/auth';
import { parseMentorRegistration } from '@/lib/contracts';
import { mentorRegistrationOpen, registerMentor, RegistrationClosedError } from '@/lib/registration';
export const runtime = 'nodejs';
/** Prazo fechado → 403 antes de qualquer consulta (nem corpo, nem limite, nem banco). */
export const POST = handle(async request => {
  requireOrigin(request);
  if (!mentorRegistrationOpen()) throw new RegistrationClosedError();
  const body = parseMentorRegistration(await readJson(request));
  const key = idempotencyKey(request);
  await enforceRate(hourlyRules('register-mentor', request, body.email));
  return ok(await registerMentor(body, { key, scope: publicIdempotencyScope('mentor', request, body.email) }), 202);
});
