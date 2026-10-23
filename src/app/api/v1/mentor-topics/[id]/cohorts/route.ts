import { createCohort, listCohorts } from '@/lib/agenda';
import { collection, creation, listQuery, reader, resource } from '@/lib/agenda-http';
import { handleWith } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { id: string };
/** Turmas de um vínculo tema↔mentora: admin/team/própria mentora; cursor opaco por id. */
export const GET = handleWith<Params>(async (request, { id }) => collection(await listCohorts(await reader(request), id, listQuery(request))));
/** POST {startsAt,endsAt,capacity,status:"draft"|"open"}: RFC3339 com offset obrigatório; Idempotency-Key. */
export const POST = handleWith<Params>(async (request, { id }) => {
  const { token, idem, body } = await creation(request);
  return resource(await createCohort(token, id, idem, body), 201);
});
