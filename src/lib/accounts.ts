/** CRUD administrativo de contas (WP-002 Task 3). Toda escrita é uma função SECURITY DEFINER que trava ator+alvo, revalida o ator e aplica o predicado de proteção sob lock. */
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, tokenDigest } from './db';
import { IdentityError, isSessionToken } from './identity';
import { participantArea } from './registration';
import { canonicalHash, encodeCursor, isUuid, parseAdminUserCreate, parseAdminUserPatch, parseListQuery, type TemporaryPasswordQueued, type UserDto, type Role } from './contracts';

export type AccountOutcome = 'ok' | 'not_found' | 'auth_required' | 'forbidden' | 'version_mismatch' | 'email_unavailable' | 'conflict_active' | 'invalid' | 'idempotency_conflict';
export type AccountResult = { outcome: AccountOutcome; user?: UserDto; users?: UserDto[]; nextCursor?: string | null; job?: TemporaryPasswordQueued };

const OUTCOMES: readonly string[] = ['ok', 'not_found', 'auth_required', 'forbidden', 'version_mismatch', 'email_unavailable', 'conflict_active', 'invalid', 'idempotency_conflict'];
const VERSION = /^[1-9][0-9]{0,17}$/;
type Row = Record<string, unknown>;
const rows = async (query: ReturnType<typeof sql>) => (await getDb().execute(query)).rows as Row[];
const outcomeOf = (row: Row | undefined): AccountOutcome => typeof row?.o_outcome === 'string' && OUTCOMES.includes(row.o_outcome) ? row.o_outcome as AccountOutcome : 'not_found';
const toUser = (row: Row): UserDto => ({
  id: String(row.o_id), email: String(row.o_email), status: row.o_status as UserDto['status'],
  roles: (Array.isArray(row.o_roles) ? row.o_roles : []).filter((r): r is Role => r === 'participant' || r === 'mentor'), version: String(row.o_version),
});
const single = (row: Row | undefined): AccountResult => outcomeOf(row) === 'ok' && row ? { outcome: 'ok', user: toUser(row) } : { outcome: outcomeOf(row) };
const digestOf = (token: string) => isSessionToken(token) ? tokenDigest(token) : null;
const requestUuid = (value: string | undefined) => value && isUuid(value) ? value : randomUUID();

export async function listAccounts(token: string, query: { cursor?: string | null; limit?: number }): Promise<AccountResult> {
  const { after, limit } = parseListQuery(query);
  const digest = digestOf(token);
  if (!digest) return { outcome: 'auth_required' };
  const found = await rows(sql`select * from internal.admin_user_list(${digest},${after}::uuid,${limit + 1})`);
  const first = found[0];
  if (first && outcomeOf(first) !== 'ok') return { outcome: outcomeOf(first) };
  const page = found.slice(0, limit).map(toUser);
  return { outcome: 'ok', users: page, nextCursor: found.length > limit && page.length ? encodeCursor(page[page.length - 1].id) : null };
}

export async function getAccount(token: string, id: string): Promise<AccountResult> {
  const digest = digestOf(token);
  if (!digest) return { outcome: 'auth_required' };
  return single((await rows(sql`select * from internal.admin_user_get(${digest},${isUuid(id) ? id : null}::uuid)`))[0]);
}

/** `version` vem do If-Match já parseado; patch é validado aqui (DTO fechado → ContractError). */
export async function updateAccount(token: string, id: string, version: string, patch: unknown, requestId?: string): Promise<AccountResult> {
  const parsed = parseAdminUserPatch(patch);
  const digest = digestOf(token);
  if (!digest) return { outcome: 'auth_required' };
  if (!isUuid(id)) return { outcome: 'not_found' };
  if (!VERSION.test(version)) return { outcome: 'version_mismatch' };
  return single((await rows(sql`select * from internal.admin_user_update(${digest},${id}::uuid,${version}::bigint,${JSON.stringify(parsed)}::jsonb,${requestUuid(requestId)}::uuid)`))[0]);
}

export async function disableAccount(token: string, id: string, version: string, requestId?: string): Promise<AccountResult> {
  const digest = digestOf(token);
  if (!digest) return { outcome: 'auth_required' };
  if (!isUuid(id)) return { outcome: 'not_found' };
  if (!VERSION.test(version)) return { outcome: 'version_mismatch' };
  return single((await rows(sql`select * from internal.admin_user_disable(${digest},${id}::uuid,${version}::bigint,${requestUuid(requestId)}::uuid)`))[0]);
}

/** Intenção de nova senha temporária (sem segredo); a chave de idempotência devolve sempre o mesmo job. */
export async function resendTemporary(token: string, id: string, idempotencyKey: string): Promise<AccountResult> {
  if (!isUuid(idempotencyKey)) throw new IdentityError('INVALID_INPUT');
  const digest = digestOf(token);
  if (!digest) return { outcome: 'auth_required' };
  if (!isUuid(id)) return { outcome: 'not_found' };
  const row = (await rows(sql`select * from internal.admin_user_resend(${digest},${id}::uuid,${idempotencyKey.toLowerCase()}::uuid)`))[0];
  const outcome = typeof row?.o_outcome === 'string' && OUTCOMES.includes(row.o_outcome) ? row.o_outcome as AccountOutcome : 'not_found';
  return outcome === 'ok' && row?.o_job ? { outcome, job: { jobId: String(row.o_job), status: 'queued' } } : { outcome };
}

export async function createAccount(token: string, idempotencyKey: string, dto: unknown, requestId?: string): Promise<AccountResult> {
  const parsed = parseAdminUserCreate(dto);
  if (!isUuid(idempotencyKey)) throw new IdentityError('INVALID_INPUT');
  const digest = digestOf(token);
  if (!digest) return { outcome: 'auth_required' };
  const participant = parsed.participant ? JSON.stringify({ goal: parsed.participant.goal, moment: parsed.participant.moment, interests: parsed.participant.interests, skills: parsed.participant.skills, area: participantArea(parsed.participant.area, parsed.participant.otherArea) }) : null;
  const mentor = parsed.mentor ? JSON.stringify({ displayName: parsed.mentor.displayName, trajectory: parsed.mentor.trajectory, specialties: parsed.mentor.specialties, availability: parsed.mentor.availability, legacyCapacity: parsed.mentor.legacyCapacity }) : null;
  return single((await rows(sql`select * from internal.admin_user_create(${digest},${idempotencyKey.toLowerCase()}::uuid,${canonicalHash(parsed)},${parsed.email},${`{${parsed.roles.join(',')}}`}::text[],${participant}::jsonb,${mentor}::jsonb,${requestUuid(requestId)}::uuid)`))[0]);
}
