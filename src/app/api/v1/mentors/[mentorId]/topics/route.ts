import { createMentorTopic, listMentorTopics } from '@/lib/agenda';
import { collection, creation, reader, resource } from '@/lib/agenda-http';
import { handleWith } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { mentorId: string };
/** Vínculos tema↔mentora (máx. 2): leitura admin/team/própria mentora; outra mentora/participante → 404. */
export const GET = handleWith<Params>(async (request, { mentorId }) => collection(await listMentorTopics(await reader(request), mentorId)));
/** POST {topicId,position}: admin ou a própria mentora; Idempotency-Key; terceiro tema ou repetição → 409 TOPIC_LIMIT. */
export const POST = handleWith<Params>(async (request, { mentorId }) => {
  const { token, idem, body } = await creation(request);
  return resource(await createMentorTopic(token, mentorId, idem, body), 201);
});
