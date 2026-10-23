import { cancelAdminEnrollment, getAdminEnrollment } from '@/lib/agenda';
import { deleting, reader, resource } from '@/lib/agenda-http';
import { handleWith } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { id: string };
export const GET = handleWith<Params>(async (request, { id }) => resource(await getAdminEnrollment(await reader(request), id)));
/** DELETE = cancelar (If-Match); já cancelada devolve o mesmo estado. Vaga só é liberada no commit. */
export const DELETE = handleWith<Params>(async (request, { id }) => {
  const { token, version } = await deleting(request);
  return resource(await cancelAdminEnrollment(token, id, version));
});
