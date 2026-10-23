import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { identitySession, isSessionToken, type IdentitySession } from './identity';

const secret = () => { const value = process.env.SESSION_SECRET; if (!value || value.length < 32 || value.startsWith('replace-')) throw new Error('Configure SESSION_SECRET em .env'); return value; };
/** Sessões stateless foram removidas: toda sessão é um token opaco revogável em auth_session. */
export function makeSession(_email: string): never { throw new Error('Sessão stateless removida; use identity.login.'); }
export function sessionTokenFromCookieHeader(header: string | null | undefined) {
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === 'tw_session') { const value = part.slice(index + 1).trim(); return isSessionToken(value) ? value : null; }
  }
  return null;
}
export async function currentSession(): Promise<IdentitySession | null> {
  const value = (await cookies()).get('tw_session')?.value;
  return isSessionToken(value) ? identitySession(value) : null;
}
export async function currentAdmin() {
  const session = await currentSession();
  if (!session || session.scope !== 'full') return null;
  const role = session.roles.includes('admin') ? 'owner' : session.roles.includes('team') ? 'member' : null;
  return role ? { email: session.email, role } : null;
}
export const unauthorized = () => Response.json({ error: 'Acesso administrativo necessário.' }, { status: 401 });
export function adminCanWrite(admin: Awaited<ReturnType<typeof currentAdmin>>) { return admin?.role === 'owner'; }
/** CSRF por sessão: HMAC do token opaco, comparado em tempo constante. */
export const csrfToken = (sessionToken: string) => createHmac('sha256', secret()).update(`csrf:${sessionToken}`).digest('base64url');
export function csrfValid(request: Request, sessionToken: string) {
  const given = request.headers.get('x-csrf-token');
  const expected = csrfToken(sessionToken);
  return typeof given === 'string' && given.length === expected.length && timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
/** Estrito: Origin ausente é recusado; Sec-Fetch-Site cross-site/same-site também. */
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const site = request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin' && site !== 'none') return false;
  const expected = process.env.APP_ORIGIN || new URL(request.url).origin;
  return origin === expected;
}
