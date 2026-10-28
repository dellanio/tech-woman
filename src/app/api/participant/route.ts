import { enforceRate, errorResponse, HttpError, hourlyRules, JsonBodyError, readJson, sameOrigin } from '@/lib/auth';
import { ContractError, parseParticipantRegistration } from '@/lib/contracts';
import { registerParticipant } from '@/lib/registration';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
/** Adapter do POST antigo: delega ao cadastro neutro do contrato v1 (mesmos limites). 202 sem token, protocolo nem ID. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Origem não autorizada.' }, { status: 403 });
  try {
    const body = parseParticipantRegistration(await readJson(request));
    await enforceRate(hourlyRules('register-participant', request, body.email));
    return Response.json(await registerParticipant(body), { status: 202, headers });
  } catch (error) {
    if (error instanceof JsonBodyError && error.reason !== 'syntax') return errorResponse(error);
    if (error instanceof HttpError && error.code === 'RATE_LIMITED') return Response.json({ error: error.message }, { status: 429, headers: { ...headers, 'Retry-After': error.headers['Retry-After'] ?? '60' } });
    if (error instanceof ContractError || error instanceof SyntaxError || (error instanceof JsonBodyError && error.reason === 'syntax')) return Response.json({ error: 'Confira os campos, área de atuação e consentimento para continuar.' }, { status: 400, headers });
    return Response.json({ error: 'Não foi possível concluir a inscrição.' }, { status: 503, headers });
  }
}
