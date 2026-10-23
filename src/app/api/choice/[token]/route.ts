import { handleWith, readJson, requireOrigin } from '@/lib/auth';
import { legacyJson, noReferrer } from '@/lib/agenda-http';
import { legacyChoices, legacyChoose } from '@/lib/service';
export const runtime = 'nodejs';
type Params = { token: string };
type Context = { params: Promise<Params> };
/** GET: histórico + instrução de ativação. POST: nunca cria match/reserva por token → 409 IDENTITY_RECONCILIATION_REQUIRED (Origin/JSON antes). */
const read = handleWith(async (_request: Request, { token }: Params) => legacyJson(await legacyChoices(token)));
const choose = handleWith(async (request: Request, { token }: Params) => { requireOrigin(request); return legacyChoose(token, await readJson(request)); });
export const GET = async (request: Request, context: Context) => noReferrer(await read(request, context));
export const POST = async (request: Request, context: Context) => noReferrer(await choose(request, context));
