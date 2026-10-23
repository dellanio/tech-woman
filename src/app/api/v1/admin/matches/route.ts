import { createMatch, listMatches } from '@/lib/agenda';
import { collection, creation, listQuery, reader, resource } from '@/lib/agenda-http';
import { handle } from '@/lib/auth';
export const runtime = 'nodejs';
/** Coleção admin/team; cruzamento com participante ou mentora protegida nunca aparece. */
export const GET = handle(async request => collection(await listMatches(await reader(request), listQuery(request))));
/** POST {participantId,mentorId} (admin): sugestão current com score/razões calculados pelo servidor; Idempotency-Key. */
export const POST = handle(async request => {
  const { token, idem, body } = await creation(request);
  return resource(await createMatch(token, idem, body), 201);
});
