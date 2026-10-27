import { handleWith, HttpError } from '@/lib/auth';
import { legacyJson, noReferrer } from '@/lib/agenda-http';
import { stateFor } from '@/lib/service';
export const runtime = 'nodejs';
type Params = { token: string };
/** Estado legado pelo hash do token; inválido/ativado/revogado/protegido → 404. Nunca registra o caminho/token. */
const read = handleWith(async (_request: Request, { token }: Params) => { const data = await stateFor(token); if (!data) throw new HttpError('NOT_FOUND'); return legacyJson(data); });
export const GET = async (request: Request, context: { params: Promise<Params> }) => noReferrer(await read(request, context));
