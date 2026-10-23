import { cancelMatch, getMatch, updateMatch } from '@/lib/agenda';
import { deleting, patching, reader, resource } from '@/lib/agenda-http';
import { handleWith } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { id: string };
export const GET = handleWith<Params>(async (request, { id }) => resource(await getMatch(await reader(request), id)));
/** PATCH {status:"suggested"|"rejected"}: só sugestão current sem reserva; nunca score/FKs nem approved→inscrição. */
export const PATCH = handleWith<Params>(async (request, { id }) => {
  const { token, version, body } = await patching(request);
  return resource(await updateMatch(token, id, version, body));
});
/** DELETE = cancelled com auditoria; legado preservado sem turma; match de reserva → 409 (cancelar a inscrição). */
export const DELETE = handleWith<Params>(async (request, { id }) => {
  const { token, version } = await deleting(request);
  return resource(await cancelMatch(token, id, version));
});
