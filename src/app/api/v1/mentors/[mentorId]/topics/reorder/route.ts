import { reorderMentorTopics } from '@/lib/agenda';
import { collection, writer } from '@/lib/agenda-http';
import { handleWith, readJson } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { mentorId: string };
/** POST {firstId,secondId}: os dois vínculos da mentora trocam para posições 1/2 numa única transação. */
export const POST = handleWith<Params>(async (request, { mentorId }) => {
  const token = await writer(request);
  return collection(await reorderMentorTopics(token, mentorId, await readJson(request)));
});
