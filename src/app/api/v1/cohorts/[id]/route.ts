import { cancelCohort, getCohort, updateCohort } from '@/lib/agenda';
import { deleting, patching, reader, resource } from '@/lib/agenda-http';
import { handleWith } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { id: string };
export const GET = handleWith<Params>(async (request, { id }) => resource(await getCohort(await reader(request), id)));
/** PATCH {startsAt?,endsAt?,capacity?,status?}: transições do DER; horário/capacidade com reservas → 409. */
export const PATCH = handleWith<Params>(async (request, { id }) => {
  const { token, version, body } = await patching(request);
  return resource(await updateCohort(token, id, version, body));
});
/** DELETE = cancelar turma sem reservas active (com reservas → 409; cancele-as antes). */
export const DELETE = handleWith<Params>(async (request, { id }) => {
  const { token, version } = await deleting(request);
  return resource(await cancelCohort(token, id, version));
});
