import { sql } from 'drizzle-orm';
import { createHash, createHmac } from 'node:crypto';
import { getDb, hashPassword, tokenDigest } from './db';
import { isSessionToken } from './identity';
import { participantArea, resolveMentorRef } from './crossing';
import { parseParticipantSignup, parseMentorRegistration, parseParticipantProfile, parseMentorProfile, parseLegacyMentorRegistration, registrationReceived, participantSignupReceived, canonicalHash, ContractError, type RegistrationReceived, type ParticipantSignup, type ParticipantSignupReceived } from './contracts';

export class RegistrationClosedError extends Error { readonly code = 'REGISTRATION_CLOSED'; readonly status = 403; constructor() { super('Cadastro de mentoras encerrado.'); } }
/** Mesmo default e semântica de service.ts (MENTOR_DEADLINE), lido a cada chamada. */
export const mentorRegistrationOpen = (now = Date.now()) => { const deadline = Date.parse(process.env.MENTOR_DEADLINE || '2026-10-31T02:59:59.999Z'); return !Number.isNaN(deadline) && now <= deadline; };
export { participantArea };
const received = (): RegistrationReceived => ({ ...registrationReceived });

export class IdempotencyConflictError extends Error { readonly code = 'IDEMPOTENCY_CONFLICT'; readonly status = 409; constructor() { super('Chave de idempotência já usada com outro corpo.'); } }
/** `scope` já é HMAC (e-mail+ação+IP): o banco nunca recebe e-mail/IP brutos nem a chave em claro. */
export type PublicIdempotency = { key: string; scope: string };
type Db = Pick<ReturnType<typeof getDb>, 'execute'>;
/** Chave + escrita no mesmo commit: crash não perde nem duplica o cadastro; repetição devolve o mesmo 202 sem tocar a conta. */
async function withIdempotency(idem: PublicIdempotency | undefined, path: string, body: unknown, work: (db: Db) => Promise<unknown>): Promise<void> {
  if (!idem) { await work(getDb()); return; }
  await getDb().transaction(async tx => {
    const [row] = (await tx.execute(sql`select * from internal.idem_begin(${idem.scope},'POST',${path},${createHash('sha256').update(idem.key.toLowerCase()).digest('hex')},${canonicalHash(body)})`)).rows as Record<string, unknown>[];
    if (row?.o_state === 'conflict') throw new IdempotencyConflictError();
    if (row?.o_state !== 'new') return;
    await work(tx);
    await tx.execute(sql`select internal.idem_finish(${String(row.o_id)}::uuid,${null}::text,202)`);
  });
}

const secret = () => { const value = process.env.SESSION_SECRET; if (!value || value.length < 32 || value.startsWith('replace-')) throw new Error('Configure SESSION_SECRET em .env'); return value; };
/** Impressão da senha para o corpo canônico da idempotência: HMAC com chave própria (estável no replay, sem senha crua e sem duplo scrypt). */
export const passwordFingerprint = (password: string) => createHmac('sha256', createHmac('sha256', secret()).update('tw:signup-idempotency:v1').digest()).update(password, 'utf8').digest('base64url');
/** Corpo canônico do cadastro: a senha vira impressão; a confirmação (já igual) fica fora. */
export const signupCanonical = (p: ParticipantSignup) => { const { password, passwordConfirmation: _confirmation, ...rest } = p; return { ...rest, passwordFingerprint: passwordFingerprint(password) }; };
const mentorUnavailable = (error: unknown) => { for (let current: unknown = error, depth = 0; current && typeof current === 'object' && depth < 4; depth++) { if ((current as { message?: unknown }).message === 'registration_mentor_unavailable') return true; current = (current as { cause?: unknown }).cause; } return false; };

/**
 * Sempre `received`/`login`: conta nova, e-mail existente, privilegiado ou legado protegido são indistinguíveis. A mentora é resolvida entre as
 * compatíveis do diagnóstico e revalidada sob lock no banco ANTES do e-mail; fora da lista → 422 `mentor_ref` sem gravar nada (independe do e-mail).
 * Conta active com o hash scrypt (calculado uma vez, fora da transação), perfil e match numa única função SQL; nenhum e-mail enfileirado.
 */
export async function registerParticipant(input: unknown, idem?: PublicIdempotency): Promise<ParticipantSignupReceived> {
  const p = parseParticipantSignup(input);
  const hash = await hashPassword(p.password);
  await withIdempotency(idem, '/api/v1/registrations/participants', signupCanonical(p), async db => {
    const mentor = await resolveMentorRef(db, p, p.mentor_ref);
    if (!mentor) throw new ContractError(['mentor_ref']);
    try { await db.execute(sql`select internal.register_participant_account(${p.email},${hash},${p.goal},${p.moment},${JSON.stringify(p.interests)}::jsonb,${JSON.stringify(p.skills)}::jsonb,${participantArea(p.area, p.otherArea)},${mentor}::bigint)`); }
    catch (error) { if (mentorUnavailable(error)) throw new ContractError(['mentor_ref']); throw error; }
  });
  return { ...participantSignupReceived };
}
/** Prazo verificado antes de qualquer consulta; fechado → RegistrationClosedError (403) sem tocar conta. */
export async function registerMentor(input: unknown, idem?: PublicIdempotency): Promise<RegistrationReceived> {
  if (!mentorRegistrationOpen()) throw new RegistrationClosedError();
  const p = parseMentorRegistration(input);
  await withIdempotency(idem, '/api/v1/registrations/mentors', p, db => db.execute(sql`select internal.register_mentor_account(${p.email},${p.displayName},${p.trajectory},${JSON.stringify(p.specialties)}::jsonb,${p.availability},${p.legacyCapacity})`));
  return received();
}

/** Adapter do cadastro antigo de mentora (sem displayName → NULL; projeções usam o fallback "Mentora #id"). `p` já passou pelo parser fechado do contrato antigo. */
export async function registerLegacyMentor(p: ReturnType<typeof parseLegacyMentorRegistration>): Promise<RegistrationReceived> {
  if (!mentorRegistrationOpen()) throw new RegistrationClosedError();
  await getDb().execute(sql`select internal.register_mentor_account(${p.email},${p.displayName},${p.trajectory},${JSON.stringify(p.specialties)}::jsonb,${p.availability},${p.legacyCapacity})`);
  return received();
}

export type OwnProfileOutcome = 'created' | 'conflict' | 'reconciliation' | 'not_found';
const outcomes: readonly string[] = ['created', 'conflict', 'reconciliation', 'not_found'];
/** Anexa perfil ao PRÓPRIO usuário da sessão full (nunca por e-mail/ID do cliente). Admin/team, sessão limitada ou inválida → not_found. */
export async function addOwnProfile(sessionToken: string, domain: 'participant' | 'mentor', input: unknown): Promise<OwnProfileOutcome> {
  if (domain === 'mentor' && !mentorRegistrationOpen()) throw new RegistrationClosedError();
  const digest = isSessionToken(sessionToken) ? tokenDigest(sessionToken) : null;
  if (domain === 'participant') {
    const p = parseParticipantProfile(input);
    if (!digest) return 'not_found';
    return outcome(await getDb().execute(sql`select internal.add_own_participant_profile(${digest},${p.goal},${p.moment},${JSON.stringify(p.interests)}::jsonb,${JSON.stringify(p.skills)}::jsonb,${participantArea(p.area, p.otherArea)}) as r`));
  }
  const p = parseMentorProfile(input);
  if (!digest) return 'not_found';
  return outcome(await getDb().execute(sql`select internal.add_own_mentor_profile(${digest},${p.displayName},${p.trajectory},${JSON.stringify(p.specialties)}::jsonb,${p.availability},${p.legacyCapacity}) as r`));
}
const outcome = (result: { rows: Record<string, unknown>[] }): OwnProfileOutcome => { const r = result.rows[0]?.r; return typeof r === 'string' && outcomes.includes(r) ? r as OwnProfileOutcome : 'not_found'; };
