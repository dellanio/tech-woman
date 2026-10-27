import { clearSessionCookie, sameOrigin, sessionTokenFromRequest } from '@/lib/auth';
import { logout } from '@/lib/identity';
export const runtime = 'nodejs';
/** Revoga a sessão opaca e limpa tw_session e o antigo tw_admin (que já não vale nada). */
export async function POST(request: Request) {
  if (!sameOrigin(request)) return Response.json({ error: 'Origem não autorizada.' }, { status: 403 });
  const token = sessionTokenFromRequest(request);
  try { if (token) await logout(token); } catch { return Response.json({ error: 'Serviço indisponível no momento.' }, { status: 503 }); }
  const response = Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  response.headers.append('Set-Cookie', clearSessionCookie());
  response.headers.append('Set-Cookie', 'tw_admin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');
  return response;
}
