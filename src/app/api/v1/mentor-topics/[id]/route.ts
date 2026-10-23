import { deleteMentorTopic, getMentorTopic, updateMentorTopic } from '@/lib/agenda';
import { deleting, patching, reader, resource } from '@/lib/agenda-http';
import { handleWith, noContent } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { id: string };
export const GET = handleWith<Params>(async (request, { id }) => resource(await getMentorTopic(await reader(request), id)));
/** PATCH {position}: só posição livre; mentora/tema nunca são reapontados. */
export const PATCH = handleWith<Params>(async (request, { id }) => {
  const { token, version, body } = await patching(request);
  return resource(await updateMentorTopic(token, id, version, body));
});
/** DELETE físico só sem turma referenciando (senão 409 COHORT_IN_USE). */
export const DELETE = handleWith<Params>(async (request, { id }) => {
  const { token, version } = await deleting(request);
  await deleteMentorTopic(token, id, version);
  return noContent();
});
