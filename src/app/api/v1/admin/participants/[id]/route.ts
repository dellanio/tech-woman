import { deactivateDomain, getDomain, updateDomain } from '@/lib/agenda';
import { deleting, patching, reader, resource } from '@/lib/agenda-http';
import { handleWith } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { id: string };
/** Protegido e inexistente respondem 404 idêntico; ETag = versão. */
export const GET = handleWith<Params>(async (request, { id }) => resource(await getDomain(await reader(request), 'participant', id)));
/** PATCH fechado (sem e-mail/userId/token/consentimento/demo); If-Match; proteção revalidada sob lock da conta. */
export const PATCH = handleWith<Params>(async (request, { id }) => {
  const { token, version, body } = await patching(request);
  return resource(await updateDomain(token, 'participant', id, version, body));
});
/** DELETE = desativar, histórico preservado; reservas ativas → 409. */
export const DELETE = handleWith<Params>(async (request, { id }) => {
  const { token, version } = await deleting(request);
  return resource(await deactivateDomain(token, 'participant', id, version));
});
