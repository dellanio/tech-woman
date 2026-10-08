import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { sqlite } from './db';

type User = { email: string; role: string; password_hash: string };
const secret = () => { const value = process.env.SESSION_SECRET; if (!value || value.length < 32 || value.startsWith('replace-')) throw new Error('Configure SESSION_SECRET em .env'); return value; };
const sign = (value: string) => createHmac('sha256', secret()).update(value).digest('hex');
export function makeSession(email: string) { const payload = Buffer.from(JSON.stringify({ email, expires: Date.now() + 86400000 })).toString('base64url'); return `${payload}.${sign(payload)}`; }
export async function currentAdmin() {
  const cookie = (await cookies()).get('tw_admin')?.value;
  if (!cookie) return null;
  const [payload, mac] = cookie.split('.');
  if (!payload || !mac || mac.length !== 64 || !timingSafeEqual(Buffer.from(mac), Buffer.from(sign(payload)))) return null;
  try {
    const data: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!data || typeof data !== 'object' || !('email' in data) || !('expires' in data) || typeof data.email !== 'string' || typeof data.expires !== 'number' || data.expires < Date.now()) return null;
    return sqlite.prepare('SELECT email,role FROM admin_user WHERE email=?').get(data.email) as Pick<User,'email'|'role'> | undefined || null;
  } catch { return null; }
}
export const unauthorized = () => Response.json({ error: 'Acesso administrativo necessário.' }, { status: 401 });
export function adminCanWrite(admin: Awaited<ReturnType<typeof currentAdmin>>) { return admin?.role === 'owner'; }
export function sameOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (!origin) return true; // SameSite=Strict cookie; non-browser clients do not set Origin.
  const expected = process.env.APP_ORIGIN || new URL(request.url).origin;
  return origin === expected;
}
