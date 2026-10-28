import { enforceRate, errorResponse, HttpError, hourlyRules, JsonBodyError, readJson, sameOrigin } from '@/lib/auth';
import { ContractError, parseParticipantSignup } from '@/lib/contracts';
import { registerParticipant } from '@/lib/registration';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
/**
 * Adapter do POST antigo: exige o MESMO DTO do cadastro v1 (mentora do crossing + senha definitiva + confirmação) e delega a ele.
 * O corpo antigo (só diagnóstico e e-mail) é recusado com 400: nenhum atalho cria participante sem credenciais ou sem crossing.
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Origem não autorizada.' }, { status: 403 });
  try {
    const body = parseParticipantSignup(await readJson(request));
    await enforceRate(hourlyRules('register-participant', request, body.email));
    return Response.json(await registerParticipant(body), { status: 202, headers });
  } catch (error) {
    if (error instanceof JsonBodyError && error.reason !== 'syntax') return errorResponse(error);
    if (error instanceof HttpError && error.code === 'RATE_LIMITED') return Response.json({ error: error.message }, { status: 429, headers: { ...headers, 'Retry-After': error.headers['Retry-After'] ?? '60' } });
    if (error instanceof ContractError || error instanceof SyntaxError || (error instanceof JsonBodyError && error.reason === 'syntax')) return Response.json({ error: 'Confira os campos, a mentora escolhida, a senha e o consentimento para continuar.' }, { status: 400, headers });
    return Response.json({ error: 'Não foi possível concluir a inscrição.' }, { status: 503, headers });
  }
}
