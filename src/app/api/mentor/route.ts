import { enforceRate, HttpError, hourlyRules, sameOrigin } from '@/lib/auth';
import { ContractError, parseLegacyMentorRegistration } from '@/lib/contracts';
import { mentorRegistrationOpen as registrationOpen, registerLegacyMentor } from '@/lib/registration';
import { mentorDeadline, mentorRegistrationOpen } from '@/lib/service';
export const runtime = 'nodejs';
const headers = { 'Cache-Control': 'no-store' };
export async function GET() { return Response.json({ open: mentorRegistrationOpen(), deadline: mentorDeadline }, { headers }); }
/** Adapter do POST antigo (campo `capacity`, sem displayName): delega ao cadastro neutro; prazo fechado → 403 antes de qualquer consulta. */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Origem não autorizada.' }, { status: 403 });
  if (!registrationOpen()) return Response.json({ error: 'Cadastro de mentoras encerrado.' }, { status: 403, headers });
  try {
    const body = parseLegacyMentorRegistration(await request.json());
    await enforceRate(hourlyRules('register-mentor', request, body.email));
    return Response.json(await registerLegacyMentor(body), { status: 202, headers });
  } catch (error) {
    if (error instanceof HttpError && error.code === 'RATE_LIMITED') return Response.json({ error: error.message }, { status: 429, headers: { ...headers, 'Retry-After': error.headers['Retry-After'] ?? '60' } });
    if (error instanceof ContractError || error instanceof SyntaxError) return Response.json({ error: 'Preencha trajetória, especialidades, disponibilidade, capacidade e consentimento.' }, { status: 400, headers });
    return Response.json({ error: 'Não foi possível cadastrar mentora.' }, { status: 503, headers });
  }
}
