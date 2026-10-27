import { listMentorCohorts } from '@/lib/recommendations';
import { collection, listQuery, reader } from '@/lib/agenda-http';
import { handleWith } from '@/lib/auth';
export const runtime = 'nodejs';
type Params = { mentorId: string };
/** Turmas open futuras da mentora ativa, com ocupação/vagas informativas e horários em UTC (timeZone America/Recife). */
export const GET = handleWith<Params>(async (request, { mentorId }) => collection(await listMentorCohorts(await reader(request), mentorId, listQuery(request))));
