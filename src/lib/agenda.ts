/**
 * Serviços de Agenda e CRUD de domínio (WP-003). Cada operação é UMA chamada a uma função SECURITY DEFINER do owner NOLOGIN:
 * ela autentica o digest da sessão, trava usuários → guard → domínio, revalida autorização/DTO e grava auditoria na mesma transação.
 * O runtime nunca informa ator/papel. 40001/40P01 refazem a transação inteira (até 3 tentativas, jitter); nada externo acontece dentro dela.
 */
import { sql, type SQL } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getDb, tokenDigest } from './db';
import { HttpError } from './auth';
import { isSessionToken } from './identity';
import { canonicalHash, encodeSqlCursor, parseCohort, parseEnrollment, parseMatchCreate, parseMatchPatch, parseMentorPatch, parseMentorRegistration, parseParticipantPatch, parseParticipantRegistration, parseReassign, parseCohortPatch, parseDomainListQuery, parseMentorTopic, parseMentorTopicPatch, parseReorder, parseSqlId, parseTopic, parseTopicPatch, type CohortDto, type EnrollmentDto, type ErrorCode, type LegacyMatchDto, type MentorTopicDto, type TopicDto } from './contracts';

export type Page<T> = { items: T[]; nextCursor: string | null };
export type ListQuery = { cursor?: unknown; limit?: unknown };
/** Contexto de tradução das recusas do banco: a mesma regra significa coisas diferentes ao reservar ou ao editar turma. */
export type Operation = 'catalog' | 'enroll' | 'cohort' | 'domain';

const API_CODES: readonly ErrorCode[] = ['INVALID_INPUT', 'AUTH_REQUIRED', 'FORBIDDEN', 'NOT_FOUND', 'EMAIL_UNAVAILABLE', 'IDENTITY_RECONCILIATION_REQUIRED', 'COHORT_FULL', 'SCHEDULE_CONFLICT',
  'COHORT_IN_USE', 'COHORT_NOT_OPEN', 'TOPIC_LIMIT', 'ALREADY_ENROLLED', 'IDEMPOTENCY_CONFLICT', 'VERSION_MISMATCH'];
type PgError = { code?: unknown; constraint?: unknown; message?: unknown; detail?: unknown; hint?: unknown; cause?: unknown };
const pgError = (error: unknown): PgError | null => {
  for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const candidate = current as PgError;
    if (typeof candidate.code === 'string' && /^[0-9A-Z]{5}$/.test(candidate.code)) return candidate;
    current = candidate.cause;
  }
  return null;
};
/** Nome estável de constraint/regra → erro do contrato. Nunca repassa SQL, nome cru, e-mail ou valores. */
function constraintError(name: string, operation: Operation): HttpError | null {
  switch (name) {
    case 'agenda_capacity_exceeded': return operation === 'enroll' ? new HttpError('COHORT_FULL') : new HttpError('COHORT_IN_USE', ['capacity'], {}, 'A capacidade não pode ficar abaixo das reservas ativas.');
    case 'agenda_mentor_overlap': case 'agenda_participant_overlap': return new HttpError('SCHEDULE_CONFLICT');
    case 'agenda_topic_limit': case 'mentor_topic_pair_unique': case 'mentor_topic_position_unique': return new HttpError('TOPIC_LIMIT');
    case 'agenda_cohort_in_use': case 'agenda_match_managed': return new HttpError('COHORT_IN_USE');
    case 'agenda_active_enrollment': return new HttpError('COHORT_IN_USE', [], {}, 'Há reservas ativas; cancele-as antes de continuar.');
    case 'agenda_cohort_not_open': return new HttpError('COHORT_NOT_OPEN');
    case 'agenda_not_future': return operation === 'enroll' ? new HttpError('COHORT_NOT_OPEN') : new HttpError('INVALID_INPUT', ['startsAt']);
    case 'agenda_inactive': return operation === 'enroll' ? new HttpError('COHORT_NOT_OPEN') : new HttpError('COHORT_NOT_OPEN', [], {}, 'Mentora ou tema inativo.');
    case 'agenda_identity_required': return new HttpError('IDENTITY_RECONCILIATION_REQUIRED');
    case 'enrollment_active_unique': return new HttpError('ALREADY_ENROLLED');
    case 'agenda_invalid_transition': return new HttpError('INVALID_INPUT', ['status']);
    case 'agenda_immutable': return new HttpError('INVALID_INPUT');
    case 'topic_slug_unique': return new HttpError('INVALID_INPUT', ['slug']);
    case 'app_user_email_key_unique': return new HttpError('EMAIL_UNAVAILABLE');
    default: return null;
  }
}
const RETRYABLE = new Set(['40001', '40P01']);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
/** Desfecho de erro do banco → HttpError; desconhecido é relançado (vira 503 genérico em errorResponse, sem detalhes). */
export function translate(error: unknown, operation: Operation): unknown {
  const pg = pgError(error);
  if (!pg) return error;
  if (pg.code === 'P0001' && pg.hint === 'tw_api' && typeof pg.message === 'string' && (API_CODES as readonly string[]).includes(pg.message)) {
    const fields = typeof pg.detail === 'string' && pg.detail ? pg.detail.split(',') : [];
    return new HttpError(pg.message as ErrorCode, fields);
  }
  if (typeof pg.constraint === 'string') { const mapped = constraintError(pg.constraint, operation); if (mapped) return mapped; }
  if (pg.code === '23503') return new HttpError('COHORT_IN_USE');
  if (pg.code === '40001' || pg.code === '40P01' || pg.code === '55P03') return new HttpError('RETRY_TRANSACTION');
  return error;
}
/** Uma operação = uma instrução/transação; reexecução integral em 40001/40P01, até 3 tentativas com jitter. Falha final → 409 RETRY_TRANSACTION. */
export async function invoke<T>(query: SQL, operation: Operation = 'domain', attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      const result = await getDb().execute(query);
      return (result.rows[0] as { r: T } | undefined)?.r as T;
    } catch (error) {
      const code = pgError(error)?.code;
      if (typeof code === 'string' && RETRYABLE.has(code) && attempt < attempts) { await sleep(10 + Math.floor(Math.random() * 40 * attempt)); continue; }
      throw translate(error, operation);
    }
  }
}

export const digestOf = (token: string) => { if (!isSessionToken(token)) throw new HttpError('AUTH_REQUIRED'); return tokenDigest(token); };
export const newRequestId = () => randomUUID();
/** ID de rota: inválido é indistinguível de inexistente (404). */
export const routeId = (value: unknown): string => { try { return parseSqlId(value); } catch { throw new HttpError('NOT_FOUND'); } };
export const versionOf = (value: string) => { if (!/^[1-9][0-9]{0,17}$/.test(value)) throw new HttpError('VERSION_MISMATCH'); return value; };
/** Lista: a função devolve até limit+1 itens; o excedente só indica a próxima página (cursor opaco = último id entregue). */
export async function page<T extends { id: string }>(query: ListQuery, run: (after: string | null, limit: number) => SQL, operation: Operation = 'domain'): Promise<Page<T>> {
  const { after, limit } = parseDomainListQuery(query);
  const rows = (await invoke<T[]>(run(after, limit), operation)) ?? [];
  const items = rows.slice(0, limit);
  return { items, nextCursor: rows.length > limit && items.length ? encodeSqlCursor(items[items.length - 1].id) : null };
}
export type Idempotent = { key: string };
const keyOf = (idem: Idempotent) => idem.key.toLowerCase();

// ---- Temas ----
export const listTopics = (token: string, query: ListQuery) => page<TopicDto>(query, (after, limit) => sql`select internal.api_topic_list(${digestOf(token)}, ${after}::bigint, ${limit}) as r`);
export const getTopic = (token: string, id: string) => invoke<TopicDto>(sql`select internal.api_topic_get(${digestOf(token)}, ${routeId(id)}::bigint) as r`);
export function createTopic(token: string, idem: Idempotent, body: unknown) {
  const dto = parseTopic(body);
  return invoke<TopicDto>(sql`select internal.api_topic_create(${digestOf(token)}, ${newRequestId()}::uuid, ${keyOf(idem)}::uuid, ${canonicalHash(dto)}, ${JSON.stringify(dto)}::jsonb) as r`);
}
export function updateTopic(token: string, id: string, version: string, body: unknown) {
  const patch = parseTopicPatch(body);
  return invoke<TopicDto>(sql`select internal.api_topic_update(${digestOf(token)}, ${newRequestId()}::uuid, ${routeId(id)}::bigint, ${versionOf(version)}::bigint, ${JSON.stringify(patch)}::jsonb, 'update') as r`);
}
export const deactivateTopic = (token: string, id: string, version: string) =>
  invoke<TopicDto>(sql`select internal.api_topic_update(${digestOf(token)}, ${newRequestId()}::uuid, ${routeId(id)}::bigint, ${versionOf(version)}::bigint, ${'{"active":false}'}::jsonb, 'deactivate') as r`);

// ---- Temas da mentora ----
const listOf = <T>(items: T[] | null): Page<T> => ({ items: items ?? [], nextCursor: null });
export const listMentorTopics = async (token: string, mentorId: string) => listOf(await invoke<MentorTopicDto[]>(sql`select internal.api_mentor_topic_list(${digestOf(token)}, ${routeId(mentorId)}::bigint) as r`));
export const getMentorTopic = (token: string, id: string) => invoke<MentorTopicDto>(sql`select internal.api_mentor_topic_get(${digestOf(token)}, ${routeId(id)}::bigint) as r`);
export function createMentorTopic(token: string, mentorId: string, idem: Idempotent, body: unknown) {
  const mentor = routeId(mentorId);
  const dto = parseMentorTopic(body);
  return invoke<MentorTopicDto>(sql`select internal.api_mentor_topic_create(${digestOf(token)}, ${newRequestId()}::uuid, ${keyOf(idem)}::uuid, ${canonicalHash(dto)}, ${mentor}::bigint, ${JSON.stringify(dto)}::jsonb) as r`);
}
export async function reorderMentorTopics(token: string, mentorId: string, body: unknown) {
  const mentor = routeId(mentorId);
  const dto = parseReorder(body);
  return listOf(await invoke<MentorTopicDto[]>(sql`select internal.api_mentor_topic_reorder(${digestOf(token)}, ${newRequestId()}::uuid, ${mentor}::bigint, ${JSON.stringify(dto)}::jsonb) as r`));
}
export function updateMentorTopic(token: string, id: string, version: string, body: unknown) {
  const patch = parseMentorTopicPatch(body);
  return invoke<MentorTopicDto>(sql`select internal.api_mentor_topic_update(${digestOf(token)}, ${newRequestId()}::uuid, ${routeId(id)}::bigint, ${versionOf(version)}::bigint, ${JSON.stringify(patch)}::jsonb) as r`);
}
export const deleteMentorTopic = async (token: string, id: string, version: string) => {
  await invoke<unknown>(sql`select internal.api_mentor_topic_delete(${digestOf(token)}, ${newRequestId()}::uuid, ${routeId(id)}::bigint, ${versionOf(version)}::bigint) as r`);
};

// ---- Turmas ----
/** Projeção de gestão (mentora/admin/team): inclui vínculo e status, além do contrato público. */
export type CohortAdminDto = CohortDto & { mentorTopicId: string; status: 'draft' | 'open' | 'closed' | 'cancelled' };
export const listCohorts = (token: string, mentorTopicId: string, query: ListQuery) => {
  const mentorTopic = routeId(mentorTopicId);
  return page<CohortAdminDto>(query, (after, limit) => sql`select internal.api_cohort_list(${digestOf(token)}, ${mentorTopic}::bigint, ${after}::bigint, ${limit}) as r`);
};
export const getCohort = (token: string, id: string) => invoke<CohortAdminDto>(sql`select internal.api_cohort_get(${digestOf(token)}, ${routeId(id)}::bigint) as r`);
export function createCohort(token: string, mentorTopicId: string, idem: Idempotent, body: unknown) {
  const mentorTopic = routeId(mentorTopicId);
  const dto = parseCohort(body);
  return invoke<CohortAdminDto>(sql`select internal.api_cohort_create(${digestOf(token)}, ${newRequestId()}::uuid, ${keyOf(idem)}::uuid, ${canonicalHash(dto)}, ${mentorTopic}::bigint, ${JSON.stringify(dto)}::jsonb) as r`, 'cohort');
}
export function updateCohort(token: string, id: string, version: string, body: unknown) {
  const patch = parseCohortPatch(body);
  return invoke<CohortAdminDto>(sql`select internal.api_cohort_update(${digestOf(token)}, ${newRequestId()}::uuid, ${routeId(id)}::bigint, ${versionOf(version)}::bigint, ${JSON.stringify(patch)}::jsonb, 'update') as r`, 'cohort');
}
export const cancelCohort = (token: string, id: string, version: string) =>
  invoke<CohortAdminDto>(sql`select internal.api_cohort_update(${digestOf(token)}, ${newRequestId()}::uuid, ${routeId(id)}::bigint, ${versionOf(version)}::bigint, ${'{"status":"cancelled"}'}::jsonb, 'cancel') as r`, 'cohort');

// ---- Reservas da própria participante (participantId vem da sessão, nunca do corpo) ----
export type OwnEnrollmentDto = EnrollmentDto & { mentor: { id: string; displayName: string }; topic: { id: string; name: string } };
export type OwnEnrollments = { enrollments: OwnEnrollmentDto[]; legacyMatches: LegacyMatchDto[] };
export const listOwnEnrollments = (token: string) => invoke<OwnEnrollments>(sql`select internal.api_my_enrollments(${digestOf(token)}) as r`);
export function enroll(token: string, idem: Idempotent, body: unknown) {
  const dto = parseEnrollment(body);
  return invoke<EnrollmentDto>(sql`select internal.api_enroll(${digestOf(token)}, ${newRequestId()}::uuid, ${keyOf(idem)}::uuid, ${canonicalHash(dto)}, ${JSON.stringify(dto)}::jsonb) as r`, 'enroll');
}
export const cancelOwnEnrollment = (token: string, id: string) =>
  invoke<EnrollmentDto>(sql`select internal.api_my_enrollment_cancel(${digestOf(token)}, ${newRequestId()}::uuid, ${routeId(id)}::bigint) as r`, 'enroll');

// ---- CRUD administrativo de participantes e mentoras (admin escreve, team lê; protegidos = 404) ----
export type DomainKind = 'participant' | 'mentor';
export type AdminParticipantDto = { id: string; email: string; goal: string; moment: string; interests: string[]; skills: string[]; area: string | null; otherArea?: string; active: boolean; userId: string | null; version: string };
export type AdminMentorDto = { id: string; email: string; displayName: string | null; trajectory: string; specialties: string[]; availability: string; legacyCapacity: number; active: boolean; demo: boolean; userId: string | null; version: string };
export type AdminDomainDto<K extends DomainKind> = K extends 'participant' ? AdminParticipantDto : AdminMentorDto;
export const listDomain = <K extends DomainKind>(token: string, kind: K, query: ListQuery) =>
  page<AdminDomainDto<K>>(query, (after, limit) => sql`select internal.api_admin_domain_list(${digestOf(token)}, ${kind}, ${after}::bigint, ${limit}) as r`);
export const getDomain = <K extends DomainKind>(token: string, kind: K, id: string) =>
  invoke<AdminDomainDto<K>>(sql`select internal.api_admin_domain_get(${digestOf(token)}, ${kind}, ${routeId(id)}::bigint) as r`);
/** POST: DTO público de cadastro (com consent:true) + conta pendente criada na mesma transação. */
export function createDomain<K extends DomainKind>(token: string, kind: K, idem: Idempotent, body: unknown) {
  const dto = kind === 'participant' ? parseParticipantRegistration(body) : parseMentorRegistration(body);
  return invoke<AdminDomainDto<K>>(sql`select internal.api_admin_domain_create(${digestOf(token)}, ${newRequestId()}::uuid, ${keyOf(idem)}::uuid, ${canonicalHash(dto)}, ${kind}, ${JSON.stringify(dto)}::jsonb) as r`);
}
export function updateDomain<K extends DomainKind>(token: string, kind: K, id: string, version: string, body: unknown) {
  const patch = kind === 'participant' ? parseParticipantPatch(body) : parseMentorPatch(body);
  return invoke<AdminDomainDto<K>>(sql`select internal.api_admin_domain_update(${digestOf(token)}, ${newRequestId()}::uuid, ${kind}, ${routeId(id)}::bigint, ${versionOf(version)}::bigint, ${JSON.stringify(patch)}::jsonb, 'update') as r`);
}
/** DELETE = desativar (soft); reservas ativas → 409 até cancelamento explícito. */
export const deactivateDomain = <K extends DomainKind>(token: string, kind: K, id: string, version: string) =>
  invoke<AdminDomainDto<K>>(sql`select internal.api_admin_domain_update(${digestOf(token)}, ${newRequestId()}::uuid, ${kind}, ${routeId(id)}::bigint, ${versionOf(version)}::bigint, ${'{"active":false}'}::jsonb, 'deactivate') as r`);

// ---- Cruzamentos administrativos (score/razões sempre do servidor) ----
export type AdminMatchDto = { id: string; participantId: string; mentorId: string; score: number; reasons: string[]; status: 'approved' | 'rejected' | 'suggested' | 'selected' | 'cancelled'; origin: 'legacy' | 'current'; enrollmentId: string | null; version: string };
export const listMatches = (token: string, query: ListQuery) => page<AdminMatchDto>(query, (after, limit) => sql`select internal.api_match_list(${digestOf(token)}, ${after}::bigint, ${limit}) as r`);
export const getMatch = (token: string, id: string) => invoke<AdminMatchDto>(sql`select internal.api_match_get(${digestOf(token)}, ${routeId(id)}::bigint) as r`);
export function createMatch(token: string, idem: Idempotent, body: unknown) {
  const dto = parseMatchCreate(body);
  return invoke<AdminMatchDto>(sql`select internal.api_match_create(${digestOf(token)}, ${newRequestId()}::uuid, ${keyOf(idem)}::uuid, ${canonicalHash(dto)}, ${JSON.stringify(dto)}::jsonb) as r`);
}
export function updateMatch(token: string, id: string, version: string, body: unknown) {
  const patch = parseMatchPatch(body);
  return invoke<AdminMatchDto>(sql`select internal.api_match_update(${digestOf(token)}, ${newRequestId()}::uuid, ${routeId(id)}::bigint, ${versionOf(version)}::bigint, ${JSON.stringify(patch)}::jsonb, 'update') as r`);
}
export const cancelMatch = (token: string, id: string, version: string) =>
  invoke<AdminMatchDto>(sql`select internal.api_match_update(${digestOf(token)}, ${newRequestId()}::uuid, ${routeId(id)}::bigint, ${versionOf(version)}::bigint, ${null}::jsonb, 'cancel') as r`);

// ---- Inscrições administrativas ----
export type AdminEnrollmentDto = EnrollmentDto & { participantId: string; cancelledAt: string | null; version: string };
export const listAdminEnrollments = (token: string, query: ListQuery) =>
  page<AdminEnrollmentDto>(query, (after, limit) => sql`select internal.api_admin_enrollment_list(${digestOf(token)}, ${after}::bigint, ${limit}) as r`);
export const getAdminEnrollment = (token: string, id: string) => invoke<AdminEnrollmentDto>(sql`select internal.api_admin_enrollment_get(${digestOf(token)}, ${routeId(id)}::bigint) as r`);
export const cancelAdminEnrollment = (token: string, id: string, version: string) =>
  invoke<AdminEnrollmentDto>(sql`select internal.api_admin_enrollment_cancel(${digestOf(token)}, ${newRequestId()}::uuid, ${routeId(id)}::bigint, ${versionOf(version)}::bigint) as r`, 'enroll');
/** Realocação atômica: cancela a origem e cria a nova reserva na mesma transação; falha no destino preserva a origem. */
export function reassignEnrollment(token: string, id: string, idem: Idempotent, body: unknown) {
  const enrollmentId = routeId(id);
  const dto = parseReassign(body);
  return invoke<AdminEnrollmentDto>(sql`select internal.api_admin_enrollment_reassign(${digestOf(token)}, ${newRequestId()}::uuid, ${keyOf(idem)}::uuid, ${canonicalHash(dto)}, ${enrollmentId}::bigint, ${JSON.stringify(dto)}::jsonb) as r`, 'enroll');
}
