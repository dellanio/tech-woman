import { enforceRate, HttpError, loginRules, sameOrigin, sessionCookieFor } from '@/lib/auth';
import { identitySession, login, logout } from '@/lib/identity';
export const runtime = 'nodejs';
const denied = () => Response.json({ error: 'Credenciais inválidas.' }, { status: 401, headers: { 'Cache-Control': 'no-store' } });
/**
 * Adapter do contrato antigo sobre a identidade nova (WP-002): mesma sessão opaca revogável `tw_session`, mesmos limites de taxa.
 * Só admin/team com senha definitiva recebem cookie; qualquer outra conta autenticada tem a sessão criada revogada na hora (401 genérico).
 */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Origem não autorizada.' }, { status: 403 });
  const input: unknown = await request.json().catch(() => null);
  if (!input || typeof input !== 'object' || !('email' in input) || !('password' in input) || typeof input.email !== 'string' || typeof input.password !== 'string') return denied();
  try {
    await enforceRate(loginRules(request, input.email));
    const result = await login(input.email, input.password);
    if (!result) return denied();
    if (result.state === 'password_change_required') {
      // a UI nova conclui a troca com este cookie limitado (10 min); a rota antiga não concede acesso administrativo
      return Response.json({ error: 'Troca de senha obrigatória.' }, { status: 403, headers: { 'Set-Cookie': sessionCookieFor(result.token, 'password_change_required'), 'Cache-Control': 'no-store' } });
    }
    const session = await identitySession(result.token);
    const role = session && session.scope === 'full' ? (session.roles.includes('admin') ? 'owner' : session.roles.includes('team') ? 'member' : null) : null;
    if (!session || !role) { await logout(result.token); return denied(); }
    return Response.json({ email: session.email, role }, { headers: { 'Set-Cookie': sessionCookieFor(result.token, 'authenticated'), 'Cache-Control': 'no-store' } });
  } catch (error) {
    if (error instanceof HttpError && error.code === 'RATE_LIMITED') return Response.json({ error: error.message }, { status: 429, headers: { 'Retry-After': error.headers['Retry-After'] ?? '60', 'Cache-Control': 'no-store' } });
    return Response.json({ error: 'Serviço indisponível no momento.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
