import { recommendationsFor } from '@/lib/recommendations';
import { listQuery, pagedObject, reader } from '@/lib/agenda-http';
import { handle } from '@/lib/auth';
export const runtime = 'nodejs';
/** Participante reconciliada da sessão: {suggested (score>0), others (score 0)} com razões legíveis; paginável. */
export const GET = handle(async request => {
  const result = await recommendationsFor(await reader(request), listQuery(request));
  return pagedObject(result.data, result.nextCursor);
});
