/** Cola HTTP v1 de Agenda/CRUD: sessão (Origin/CSRF/escopo) → serviço → envelope com no-store, requestId, ETag e página. Autorização final é do banco. */
import { apiSuccess } from './contracts';
import { etag, idempotencyKey, ifMatch, ok, okCollection, readJson, requireSession } from './auth';
import type { ListQuery, Page } from './agenda';

/** Leitura: sessão full; papéis/visibilidade são decididos pela função SQL (404 para ID não autorizado). */
export const reader = async (request: Request) => (await requireSession(request)).token;
/** Mutação: Origin + sessão full + CSRF; o banco revalida ator e papel sob lock. */
export const writer = async (request: Request) => (await requireSession(request, { mutation: true })).token;
export const listQuery = (request: Request): ListQuery => {
  const params = new URL(request.url).searchParams;
  const limit = params.get('limit');
  return { cursor: params.get('cursor') ?? undefined, limit: limit === null ? undefined : /^-?\d+$/.test(limit) ? Number(limit) : limit };
};
export const collection = <T>(result: Page<T>) => okCollection(result.items, result.nextCursor);
/** Objeto paginado (recomendações): `{data:{...}, page:{nextCursor}, requestId}` com no-store. */
export const pagedObject = <T>(data: T, nextCursor: string | null) =>
  new Response(JSON.stringify({ ...apiSuccess(data), page: { nextCursor } }), { status: 200, headers: { 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8' } });
type Versioned = { version: string };
/** Recurso com versão: ETag = versão. */
export const resource = <T extends Versioned>(data: T, status = 200) => ok(data, status, etag(data.version));
/** POST com corpo JSON e Idempotency-Key obrigatória (422 se ausente/ inválida), ambos lidos antes de tocar o banco. */
export async function creation(request: Request) {
  const token = await writer(request);
  const key = idempotencyKey(request);
  return { token, idem: { key }, body: await readJson(request) };
}
/** PATCH: If-Match obrigatório (428/412) e corpo JSON. */
export async function patching(request: Request) {
  const token = await writer(request);
  const version = ifMatch(request);
  return { token, version, body: await readJson(request) };
}
/** DELETE administrativo/Agenda: If-Match obrigatório, sem corpo. */
export async function deleting(request: Request) {
  const token = await writer(request);
  return { token, version: ifMatch(request) };
}
/** Rotas com token legado no caminho: além do no-store, o caminho nunca vaza por Referer (inclusive nas respostas de erro). */
export const noReferrer = (response: Response) => { response.headers.set('Referrer-Policy', 'no-referrer'); return response; };
/** Formato antigo (sem envelope) para as telas legadas, sempre com no-store. */
export const legacyJson = (data: unknown) => Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
