import { ContractError } from '@/lib/contracts';
import { listEligibleMentors } from '@/lib/recommendations';
import { collection, listQuery, reader } from '@/lib/agenda-http';
import { handle } from '@/lib/auth';
export const runtime = 'nodejs';
/** GET /mentors?eligible=true: participante/mentora/admin; projeção pública {id,displayName,demo,trajectory,specialties}, nunca e-mail/conta. */
export const GET = handle(async request => {
  const token = await reader(request);
  if (new URL(request.url).searchParams.get('eligible') !== 'true') throw new ContractError(['eligible']);
  return collection(await listEligibleMentors(token, listQuery(request)));
});
