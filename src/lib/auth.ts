import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { identitySession, isSessionToken, rateHit, IdentityError, type IdentitySession, type IdentityRole } from './identity';
import { apiError, apiSuccess, ContractError, parseIdempotencyKey, type ErrorCode } from './contracts';
import { IdempotencyConflictError, RegistrationClosedError } from './registration';

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

// ---- Cookie de sessão ----
const secureFlag = () => process.env.NODE_ENV === 'production' && process.env.ALLOW_LOCAL_HTTP !== '1' ? '; Secure' : '';
export const LIMITED_MAX_AGE = 600, FULL_MAX_AGE = 86400;
export const sessionCookie = (token: string, maxAge: number) => `tw_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secureFlag()}`;
export const sessionCookieFor = (token: string, state: 'authenticated' | 'password_change_required') => sessionCookie(token, state === 'authenticated' ? FULL_MAX_AGE : LIMITED_MAX_AGE);
export const clearSessionCookie = () => `tw_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureFlag()}`;

// ---- Envelope, erros e handler ----
const STATUS: Record<ErrorCode, number> = {
  INVALID_JSON: 400, INVALID_RESET: 400, AUTH_REQUIRED: 401, INVALID_CREDENTIALS: 401, FORBIDDEN: 403, PASSWORD_CHANGE_REQUIRED: 403, CSRF_REJECTED: 403, NOT_FOUND: 404,
  EMAIL_UNAVAILABLE: 409, IDENTITY_RECONCILIATION_REQUIRED: 409, COHORT_FULL: 409, SCHEDULE_CONFLICT: 409, COHORT_IN_USE: 409, COHORT_NOT_OPEN: 409, TOPIC_LIMIT: 409, ALREADY_ENROLLED: 409,
  IDEMPOTENCY_CONFLICT: 409, RETRY_TRANSACTION: 409, PROFILE_EXISTS: 409, VERSION_MISMATCH: 412, PRECONDITION_REQUIRED: 428, INVALID_INPUT: 422, RATE_LIMITED: 429, MAINTENANCE: 503, DEPENDENCY_UNAVAILABLE: 503,
};
const MESSAGE: Record<ErrorCode, string> = {
  INVALID_JSON: 'Envie um JSON válido.', INVALID_RESET: 'Link de redefinição inválido ou vencido.', AUTH_REQUIRED: 'Entre para continuar.', INVALID_CREDENTIALS: 'Credenciais inválidas.',
  FORBIDDEN: 'Acesso não permitido.', PASSWORD_CHANGE_REQUIRED: 'Troque a senha temporária para continuar.', CSRF_REJECTED: 'Requisição recusada.', NOT_FOUND: 'Não encontrado.',
  EMAIL_UNAVAILABLE: 'Este e-mail não está disponível.', IDENTITY_RECONCILIATION_REQUIRED: 'Precisamos conferir seu cadastro anterior; procure a organização.', COHORT_FULL: 'Esta turma ficou sem vagas.',
  SCHEDULE_CONFLICT: 'Horário em conflito.', COHORT_IN_USE: 'A turma possui reservas.', COHORT_NOT_OPEN: 'A turma não está aberta.', TOPIC_LIMIT: 'Limite de temas atingido.', ALREADY_ENROLLED: 'Reserva já existente.',
  IDEMPOTENCY_CONFLICT: 'Esta chave de idempotência já foi usada com outro conteúdo.', RETRY_TRANSACTION: 'Conflito momentâneo; tente novamente.', PROFILE_EXISTS: 'Você já possui este perfil.',
  VERSION_MISMATCH: 'O registro mudou; recarregue e tente novamente.', PRECONDITION_REQUIRED: 'Informe If-Match com a versão atual.', INVALID_INPUT: 'Confira os dados informados.',
  RATE_LIMITED: 'Muitas tentativas. Aguarde um pouco e tente de novo.', MAINTENANCE: 'Em manutenção.', DEPENDENCY_UNAVAILABLE: 'Serviço indisponível no momento.',
};
export class HttpError extends Error {
  readonly status: number;
  constructor(readonly code: ErrorCode, readonly fields: string[] = [], readonly headers: Record<string, string> = {}, message?: string) { super(code); this.status = STATUS[code]; this.message = message ?? MESSAGE[code]; }
}
/** Todas as respostas de auth/sessão/admin saem com no-store. */
const send = (status: number, body: unknown, headers: HeadersInit = {}) => {
  const out = new Headers(headers);
  out.set('Cache-Control', 'no-store');
  if (body !== undefined) out.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(body === undefined ? null : JSON.stringify(body), { status, headers: out });
};
export const ok = <T>(data: T, status = 200, headers: HeadersInit = {}) => send(status, apiSuccess(data), headers);
export const okCollection = <T>(data: T[], nextCursor: string | null) => send(200, { ...apiSuccess(data), page: { nextCursor } });
export const noContent = (headers: HeadersInit = {}) => send(204, undefined, headers);
const failure = (error: HttpError) => send(error.status, apiError(error.code, error.message, error.fields), error.headers);
const pgCode = (error: unknown): string | null => {
  for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    current = (current as { cause?: unknown }).cause;
  }
  return null;
};
/** Nunca devolve nem registra mensagem/params do driver (podem conter e-mail ou senha): só nome e SQLSTATE. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) return failure(error);
  if (error instanceof ContractError) return failure(new HttpError('INVALID_INPUT', error.fields));
  if (error instanceof IdempotencyConflictError) return failure(new HttpError('IDEMPOTENCY_CONFLICT'));
  if (error instanceof RegistrationClosedError) return failure(new HttpError('FORBIDDEN', [], {}, 'Cadastro de mentoras encerrado.'));
  if (error instanceof IdentityError) return failure(new HttpError(error.code));
  const state = pgCode(error);
  console.error('api_error', { name: error instanceof Error ? error.name : 'unknown', sqlstate: state });
  return failure(new HttpError(state === '40001' || state === '40P01' || state === '55P03' ? 'RETRY_TRANSACTION' : 'DEPENDENCY_UNAVAILABLE'));
}
/** Envolve um handler de rota estática: captura e converte erros no envelope normativo. */
export function handle(fn: (request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try { return await fn(request); } catch (error) { return errorResponse(error); }
  };
}
/** Idem para rotas dinâmicas (`[id]`): o Next 15 exige o contexto `{ params: Promise }` como segundo argumento. */
export function handleWith<P>(fn: (request: Request, params: P) => Promise<Response>) {
  return async (request: Request, context: { params: Promise<P> }): Promise<Response> => {
    try { return await fn(request, await context.params); } catch (error) { return errorResponse(error); }
  };
}

// ---- Requisição ----
export const requireOrigin = (request: Request) => { if (!sameOrigin(request)) throw new HttpError('CSRF_REJECTED'); };
export async function readJson(request: Request): Promise<unknown> {
  if (!/^application\/json\s*(;|$)/i.test(request.headers.get('content-type') ?? '')) throw new HttpError('INVALID_JSON');
  const text = await request.text();
  if (text.length > 65536) throw new HttpError('INVALID_JSON');
  try { return JSON.parse(text); } catch { throw new HttpError('INVALID_JSON'); }
}
export const idempotencyKey = (request: Request) => parseIdempotencyKey(request.headers.get('idempotency-key'));
export const sessionTokenFromRequest = (request: Request) => sessionTokenFromCookieHeader(request.headers.get('cookie'));
export type RequiredSession = { token: string; session: IdentitySession };
/**
 * Sessão obrigatória. Ordem: Origin (mutação) → sessão (401) → escopo (403 PASSWORD_CHANGE_REQUIRED, salvo `full:false`) → CSRF (mutação) → papel (403 FORBIDDEN; 404 para quem não está em `visibleTo`).
 * A autorização final de cada operação sensível é revalidada no banco, sob lock.
 */
export async function requireSession(request: Request, options: { mutation?: boolean; full?: boolean; roles?: readonly IdentityRole[]; visibleTo?: readonly IdentityRole[] } = {}): Promise<RequiredSession> {
  if (options.mutation) requireOrigin(request);
  const token = sessionTokenFromRequest(request);
  const session = token ? await identitySession(token) : null;
  if (!token || !session) throw new HttpError('AUTH_REQUIRED');
  if (options.full !== false && session.scope !== 'full') throw new HttpError('PASSWORD_CHANGE_REQUIRED');
  if (options.mutation && !csrfValid(request, token)) throw new HttpError('CSRF_REJECTED');
  const wanted = options.roles;
  // Rotas por ID: quem nem enxerga a área (`visibleTo`) recebe 404 idêntico ao de ID inexistente; quem enxerga mas não escreve (team) recebe 403.
  const area = options.visibleTo;
  if (area && !session.roles.some(role => area.includes(role))) throw new HttpError('NOT_FOUND');
  if (wanted && !session.roles.some(role => wanted.includes(role))) throw new HttpError('FORBIDDEN');
  return { token, session };
}
/** If-Match: ausente → 428; mal formado ou fraco → 412 (nunca casa). Aceita `"7"` ou `7`. */
export function ifMatch(request: Request): string {
  const raw = request.headers.get('if-match');
  if (raw === null) throw new HttpError('PRECONDITION_REQUIRED');
  const match = /^"?([1-9][0-9]{0,17})"?$/.exec(raw.trim());
  if (!match) throw new HttpError('VERSION_MISMATCH');
  return match[1];
}
export const etag = (version: string) => ({ ETag: `"${version}"` });

// ---- Limites de taxa (PG), chaves HMAC ----
const rateSecret = () => {
  const explicit = process.env.RATE_LIMIT_SECRET;
  return explicit && explicit.length >= 32 ? explicit : createHmac('sha256', secret()).update('tw:rate-limit:v1').digest('hex');
};
/** Balde = HMAC-SHA256(ação + partes); o banco nunca vê e-mail ou IP. */
export const bucket = (action: string, ...parts: string[]) => createHmac('sha256', rateSecret()).update([action, ...parts].join('\u0000')).digest('base64url');
const envInt = (name: string, fallback: number) => { const n = Number(process.env[name]); return Number.isInteger(n) && n >= 1 && n <= 100000 ? n : fallback; };
const IPV4 = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const IPV6 = /^(?=.*:.*:)[0-9a-f:.]{2,45}$/i;
/** IP só do último salto de X-Forwarded-For (o proxy configurado) com TRUST_PROXY=1; senão balde compartilhado 'direct'. */
export function clientIp(request: Request): string {
  if (process.env.TRUST_PROXY !== '1') return 'direct';
  const hops = (request.headers.get('x-forwarded-for') ?? '').split(',').map(v => v.trim()).filter(Boolean);
  const last = hops[hops.length - 1];
  return last && (IPV4.test(last) || IPV6.test(last)) ? last.toLowerCase() : 'direct';
}
export const emailKey = (email: string) => email.trim().toLowerCase();
export type RateRule = { key: string; limit: number; window: number };
export async function enforceRate(rules: RateRule[]): Promise<void> {
  let retry = 0;
  for (const rule of rules) { const result = await rateHit(rule.key, rule.limit, rule.window); if (!result.allowed) retry = Math.max(retry, result.retryAfter); }
  if (retry > 0) throw new HttpError('RATE_LIMITED', [], { 'Retry-After': String(retry) });
}
export const loginRules = (request: Request, email: string): RateRule[] => {
  const ip = clientIp(request);
  return [{ key: bucket('login', emailKey(email), ip), limit: envInt('RATE_LOGIN_PAIR_PER_MIN', 5), window: 60 }, { key: bucket('login-ip', ip), limit: envInt('RATE_LOGIN_IP_PER_MIN', 30), window: 60 }];
};
/** forgot / cadastro / reenvio: 3/h por e-mail+ação e 20/h por IP (por ação). */
export const hourlyRules = (action: string, request: Request, email: string): RateRule[] => [
  { key: bucket(action, emailKey(email)), limit: envInt('RATE_EMAIL_PER_HOUR', 3), window: 3600 },
  { key: bucket(`${action}-ip`, clientIp(request)), limit: envInt('RATE_IP_PER_HOUR', 20), window: 3600 },
];
export const resetRules = (request: Request): RateRule[] => [{ key: bucket('reset-ip', clientIp(request)), limit: envInt('RATE_RESET_IP_PER_MIN', 10), window: 60 }];
/** Escopo de idempotência do cadastro público: HMAC de e-mail+ação+IP. */
export const publicIdempotencyScope = (action: string, request: Request, email: string) => bucket('idempotency', action, emailKey(email), clientIp(request));
