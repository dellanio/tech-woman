import { enroll, listOwnEnrollments } from '@/lib/agenda';
import { creation, reader } from '@/lib/agenda-http';
import { handle, ok } from '@/lib/auth';
export const runtime = 'nodejs';
/** Reservas próprias + legacyMatches (mentoria legada sem horário inventado). */
export const GET = handle(async request => ok(await listOwnEnrollments(await reader(request))));
/** POST {cohortId}: participante vem da sessão; score 0 aceito sem aprovação; Idempotency-Key obrigatória. */
export const POST = handle(async request => {
  const { token, idem, body } = await creation(request);
  return ok(await enroll(token, idem, body), 201);
});
