'use client';
import Link from 'next/link';
import { ThemeButton } from './components';
import type { ErrorCode, Role } from '@/lib/contracts';
export const topics = [{value:'produto',label:'Produto'},{value:'dados',label:'Dados'},{value:'desenvolvimento',label:'Desenvolvimento'},{value:'design',label:'Design'}];
export const abilities = [{value:'comunicacao',label:'Comunicação'},{value:'analise',label:'Análise'},{value:'codigo',label:'Programação'},{value:'gestao',label:'Gestão'}];
export function Frame({children,eyebrow}:{children:React.ReactNode;eyebrow:string}){return <><header className="site-header"><Link className="wordmark" href="/">TECH<span>WOMAN</span><i aria-hidden="true"/></Link><nav aria-label="Navegação principal"><Link href="/">O encontro</Link><Link href="/inscricao">Participar</Link><Link href="/mentora">Para mentoras</Link></nav><div className="header-tools"><ThemeButton/><Link className="header-account" href="/login">Conta</Link></div><Link className="header-mentor" href="/mentora">Quero ser mentora</Link><Link className="header-action" href="/inscricao">Quero participar ↗</Link></header><main id="conteudo" className="inner-page"><div className="inner-meta"><Link href="/" className="back-link">← Voltar ao encontro</Link><span>{eyebrow}</span></div>{children}</main></>}
export function Chips({options,values,onChange,name}:{options:{value:string;label:string}[];values:string[];onChange:(items:string[])=>void;name:string}){return <div className="chip-group">{options.map(option=><label key={option.value}><input type="checkbox" name={name} checked={values.includes(option.value)} onChange={()=>onChange(values.includes(option.value)?values.filter(v=>v!==option.value):values.length<3?[...values,option.value]:values)}/><span>{option.label}</span></label>)}</div>}
export async function postJson<T>(url:string,body:object):Promise<T>{ const res=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); const data:unknown=await res.json(); if(!res.ok){if(data && typeof data==='object' && 'error' in data && typeof data.error==='string')throw new Error(data.error);throw new Error('Não foi possível concluir. Tente novamente.');} return data as T; }

// ---- Cliente HTTP v1 (envelope {data} / {error:{code}}) ----
/** Códigos do contrato v1 mais dois locais: falha de rede e resposta fora do contrato. */
export type ApiErrorCode = ErrorCode | 'NETWORK' | 'UNEXPECTED';
export type ApiOk<T> = { ok: true; status: number; data: T; etag: string | null; nextCursor: string | null };
export type ApiFailure = { ok: false; status: number; code: ApiErrorCode; message: string; fields: string[] };
export type ApiResult<T> = ApiOk<T> | ApiFailure;
export type RequestOptions = {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  body?: unknown;
  /** CSRF ligado à sessão; padrão: toda mutação. Use `false` só em login, cadastro, esqueci e reset públicos. */
  csrf?: boolean;
  /** UUID estável por tentativa lógica (reenvios de rede reutilizam a mesma chave). */
  idempotencyKey?: string;
  /** Versão do ETag lido antes de PATCH/DELETE. */
  ifMatch?: string;
  signal?: AbortSignal;
};
/** Mensagens próprias da interface: nunca exibimos texto técnico, status nem stack do servidor. */
const MESSAGES: Record<ApiErrorCode, string> = {
  INVALID_JSON: 'Não foi possível enviar os dados. Tente novamente.', INVALID_INPUT: 'Confira os campos destacados.', AUTH_REQUIRED: 'Entre na sua conta para continuar.',
  INVALID_CREDENTIALS: 'E-mail ou senha não conferem.', FORBIDDEN: 'Esta área não está disponível para a sua conta.', PASSWORD_CHANGE_REQUIRED: 'Defina sua senha definitiva para continuar.',
  CSRF_REJECTED: 'Sua sessão mudou. Recarregue a página e tente novamente.', NOT_FOUND: 'Não encontramos este registro.', EMAIL_UNAVAILABLE: 'Não foi possível usar este e-mail.',
  IDENTITY_RECONCILIATION_REQUIRED: 'Precisamos conferir seu cadastro anterior. Procure a organização.', COHORT_FULL: 'Esta turma ficou sem vagas.', SCHEDULE_CONFLICT: 'Você já tem uma reserva neste horário.',
  COHORT_IN_USE: 'A turma já possui reservas.', COHORT_NOT_OPEN: 'Esta turma não está aberta para reservas.', TOPIC_LIMIT: 'Limite de temas atingido.', ALREADY_ENROLLED: 'Você já tem esta reserva.',
  IDEMPOTENCY_CONFLICT: 'Esta tentativa já foi usada com outros dados. Recarregue e tente novamente.', RETRY_TRANSACTION: 'Houve uma disputa momentânea. Tente novamente.',
  VERSION_MISMATCH: 'Este registro mudou desde que você abriu. Atualize para ver a versão atual.', PRECONDITION_REQUIRED: 'Atualize o registro antes de salvar.',
  RATE_LIMITED: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.', MAINTENANCE: 'Estamos em manutenção. Tente mais tarde.', DEPENDENCY_UNAVAILABLE: 'Serviço indisponível no momento. Tente novamente em instantes.',
  INVALID_RESET: 'Este código de redefinição é inválido, já foi usado ou venceu.', PROFILE_EXISTS: 'Você já possui este perfil.', NETWORK: 'Sem conexão com o servidor. Verifique sua internet e tente novamente.',
  UNEXPECTED: 'Não foi possível concluir. Tente novamente.',
};
const CODES = new Set<string>(Object.keys(MESSAGES));
export const errorMessage = (code: ApiErrorCode) => MESSAGES[code];
const failure = (status: number, code: ApiErrorCode, fields: string[] = []): ApiFailure => ({ ok: false, status, code, message: MESSAGES[code], fields });
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const quoted = (version: string) => /^".*"$/.test(version) ? version : `"${version}"`;
/** UUID v4; fora de contexto seguro (sem randomUUID) monta a partir de getRandomValues. */
export function newIdempotencyKey(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

async function csrfHeader(signal?: AbortSignal): Promise<ApiResult<string>> {
  const result = await request<{ csrfToken: string }>('/api/v1/auth/csrf', { signal });
  if (!result.ok) return result;
  return typeof result.data?.csrfToken === 'string' ? { ...result, data: result.data.csrfToken } : failure(result.status, 'UNEXPECTED');
}
/** Único caminho da UI para a API v1: envelope tipado, ETag e erro de código seguro; nunca lança. */
export async function request<T>(path: string, options: RequestOptions = {}): Promise<ApiResult<T>> {
  if (!path.startsWith('/api/v1/')) return failure(0, 'UNEXPECTED');
  const method = options.method ?? 'GET';
  const headers = new Headers({ Accept: 'application/json' });
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  if (options.csrf ?? method !== 'GET') {
    const token = await csrfHeader(options.signal);
    if (!token.ok) return token;
    headers.set('X-CSRF-Token', token.data);
  }
  if (options.idempotencyKey) headers.set('Idempotency-Key', options.idempotencyKey);
  if (options.ifMatch) headers.set('If-Match', quoted(options.ifMatch));
  let response: Response;
  try {
    response = await fetch(path, { method, headers, credentials: 'same-origin', cache: 'no-store', signal: options.signal, ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
  } catch { return failure(0, 'NETWORK'); }
  const etag = response.headers.get('etag');
  // 204 (logout, reset) não tem corpo: nada a interpretar.
  if (response.status === 204) return response.ok ? { ok: true, status: 204, data: null as T, etag, nextCursor: null } : failure(204, 'UNEXPECTED');
  let body: unknown = null;
  try { body = await response.json(); } catch { return failure(response.status, 'UNEXPECTED'); }
  if (response.ok) {
    if (!isRecord(body) || !('data' in body)) return failure(response.status, 'UNEXPECTED');
    const page = isRecord(body.page) && typeof body.page.nextCursor === 'string' ? body.page.nextCursor : null;
    return { ok: true, status: response.status, data: body.data as T, etag, nextCursor: page };
  }
  const error = isRecord(body) && isRecord(body.error) ? body.error : {};
  const code = typeof error.code === 'string' && CODES.has(error.code) ? error.code as ApiErrorCode : 'UNEXPECTED';
  const fields = Array.isArray(error.fields) ? error.fields.filter((f): f is string => typeof f === 'string') : [];
  return failure(response.status, code, fields);
}

// ---- Sessão ----
export type SessionUser = { id: string; email: string; roles: Role[] };
export type SessionView =
  | { state: 'anonymous' }
  | { state: 'password_change_required'; expiresAt: string }
  | { state: 'authenticated'; user: SessionUser; expiresAt: string };
/** 401 vira `anonymous`; outros erros (rede, indisponível) sobem para a tela decidir. */
export async function loadSession(signal?: AbortSignal): Promise<ApiResult<SessionView>> {
  const result = await request<SessionView>('/api/v1/auth/session', { signal });
  if (!result.ok && result.code === 'AUTH_REQUIRED') return { ok: true, status: 401, data: { state: 'anonymous' }, etag: null, nextCursor: null };
  return result;
}
export const DEFAULT_AFTER_LOGIN = '/login';
const AUTH_PAGES = ['/login', '/troca-senha', '/recuperar-senha', '/redefinir-senha'];
/** Destino local seguro: só caminho interno, sem `//`, barra invertida, controle, API ou páginas de credencial. */
export function safeNext(raw: unknown, fallback = DEFAULT_AFTER_LOGIN): string {
  if (typeof raw !== 'string' || raw.length > 512 || !raw.startsWith('/') || raw.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(raw)) return fallback;
  try {
    const url = new URL(raw, 'http://destino.invalid');
    if (url.origin !== 'http://destino.invalid' || url.pathname.startsWith('/api/') || AUTH_PAGES.includes(url.pathname)) return fallback;
    return url.pathname + url.search + url.hash;
  } catch { return fallback; }
}
const withNext = (page: string, next: string) => next === DEFAULT_AFTER_LOGIN ? page : `${page}?next=${encodeURIComponent(next)}`;
export const loginHref = (next?: string) => withNext('/login', safeNext(next));
export const passwordChangeHref = (next?: string) => withNext('/troca-senha', safeNext(next));
/** Para telas protegidas: sessão ausente → login; sessão limitada → troca obrigatória. `null` = seguir na tela. */
export function authRedirect(code: ApiErrorCode, next: string): string | null {
  return code === 'AUTH_REQUIRED' ? loginHref(next) : code === 'PASSWORD_CHANGE_REQUIRED' ? passwordChangeHref(next) : null;
}
