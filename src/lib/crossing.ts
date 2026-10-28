/** Crossing do cadastro público (AJUSTE-INSCRICAO): mentoras compatíveis com o diagnóstico, sem persistência, com referência opaca. */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { getDb } from './db';
import { parseRegistrationPreview, type CrossingChoice, type ParticipantPreview } from './contracts';

type Db = Pick<ReturnType<typeof getDb>, 'execute'>;
const secret = () => { const value = process.env.SESSION_SECRET; if (!value || value.length < 32 || value.startsWith('replace-')) throw new Error('Configure SESSION_SECRET em .env'); return value; };
/** Chave própria derivada do segredo de sessão: a referência não serve para outro fim (CSRF, rate, idempotência). */
const refKey = () => createHmac('sha256', secret()).update('tw:mentor-ref:v1').digest();
/** HMAC-SHA256 do id em base64url (43 caracteres): estável com o mesmo segredo, nunca sequencial nem decodificável. */
export const mentorRef = (mentorId: string) => createHmac('sha256', refKey()).update(`mentor:${mentorId}`).digest('base64url');

/** Área gravada no perfil e usada no ranking ("outra: …" nunca coincide com especialidade). */
export const participantArea = (area: string, otherArea?: string) => area === 'outra' ? `outra: ${otherArea}` : area;
type Candidate = { id: string; name: string };
const isCandidate = (value: unknown): value is Candidate => !!value && typeof value === 'object' && typeof (value as Candidate).id === 'string' && typeof (value as Candidate).name === 'string';
/** Compatíveis na ordem do ranking (internal.registration_preview: só leitura). */
export async function crossingCandidates(db: Db, p: ParticipantPreview): Promise<Candidate[]> {
  const row = (await db.execute(sql`select internal.registration_preview(${p.goal},${p.moment},${JSON.stringify(p.interests)}::jsonb,${JSON.stringify(p.skills)}::jsonb,${participantArea(p.area, p.otherArea)}) as r`)).rows[0] as { r?: unknown } | undefined;
  return Array.isArray(row?.r) ? row.r.filter(isCandidate) : [];
}
/** Só nome e referência; nada é gravado. DTO inválido → ContractError (422). */
export async function previewCrossing(input: unknown): Promise<CrossingChoice[]> {
  const p = parseRegistrationPreview(input);
  return (await crossingCandidates(getDb(), p)).map(c => ({ mentor_ref: mentorRef(c.id), nome_exibicao: c.name }));
}
/** Resolve a referência entre as compatíveis DESTE diagnóstico (comparação em tempo constante). Fora da lista → null; o banco revalida sob lock. */
export async function resolveMentorRef(db: Db, p: ParticipantPreview, ref: string): Promise<string | null> {
  const wanted = Buffer.from(ref);
  for (const c of await crossingCandidates(db, p)) { const mine = Buffer.from(mentorRef(c.id)); if (mine.length === wanted.length && timingSafeEqual(mine, wanted)) return c.id; }
  return null;
}
