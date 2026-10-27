import { getEligibleMentor } from '@/lib/recommendations';
import { reader } from '@/lib/agenda-http';
import { handleWith, ok } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { mentorId: string };
/** Projeção pública de mentora elegível; inelegível/inexistente → 404. Sem ETag de conta. */
export const GET = handleWith<Params>(async (request, { mentorId }) => ok(await getEligibleMentor(await reader(request), mentorId)));
