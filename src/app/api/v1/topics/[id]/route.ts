import { deactivateTopic, getTopic, updateTopic } from '@/lib/agenda';
import { deleting, patching, reader, resource } from '@/lib/agenda-http';
import { handleWith } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { id: string };
export const GET = handleWith<Params>(async (request, { id }) => resource(await getTopic(await reader(request), id)));
/** PATCH {name?,description?,active?}; If-Match; só admin. */
export const PATCH = handleWith<Params>(async (request, { id }) => {
  const { token, version, body } = await patching(request);
  return resource(await updateTopic(token, id, version, body));
});
/** DELETE = desativar (tema com reserva ativa → 409). */
export const DELETE = handleWith<Params>(async (request, { id }) => {
  const { token, version } = await deleting(request);
  return resource(await deactivateTopic(token, id, version));
});
