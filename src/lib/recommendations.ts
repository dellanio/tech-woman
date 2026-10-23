/** Catálogo de escolha e recomendações (WP-003): ranking legado calculado no banco (internal.agenda_ranking), só mentoras elegíveis e só projeção pública. */
import { sql } from 'drizzle-orm';
import { ContractError, encodeSqlCursor, parseDomainListQuery, type CohortDto, type MentorChoiceDto } from './contracts';
import { digestOf, invoke, page, routeId, type ListQuery } from './agenda';

export type RankedChoice = MentorChoiceDto & { score: number; reasons: string[] };
export type Recommendations = { suggested: RankedChoice[]; others: RankedChoice[] };

/** `/mentors?eligible=true`: participante/mentora/admin; sem score (informativo, o POST de reserva revalida). */
export const listEligibleMentors = (token: string, query: ListQuery) =>
  page<MentorChoiceDto>(query, (after, limit) => sql`select internal.api_catalog_mentors(${digestOf(token)}, ${after}::bigint, ${limit}) as r`, 'catalog');
export const getEligibleMentor = (token: string, mentorId: string) =>
  invoke<MentorChoiceDto>(sql`select internal.api_catalog_mentor(${digestOf(token)}, ${routeId(mentorId)}::bigint) as r`, 'catalog');
export const listMentorCohorts = (token: string, mentorId: string, query: ListQuery) => {
  const mentor = routeId(mentorId);
  return page<CohortDto>(query, (after, limit) => sql`select internal.api_catalog_cohorts(${digestOf(token)}, ${mentor}::bigint, ${after}::bigint, ${limit}) as r`, 'catalog');
};

/**
 * Ranking inteiro (score desc, empate por mentorId), paginado pela posição do último mentorId entregue.
 * suggested = score>0; others = score 0 — sem top3: toda mentora elegível continua escolhível.
 * Cursor de mentora que deixou de ser elegível → 422 (recarregar do início).
 */
export async function recommendationsFor(token: string, query: ListQuery): Promise<{ data: Recommendations; nextCursor: string | null }> {
  const { after, limit } = parseDomainListQuery(query);
  const ranked = (await invoke<RankedChoice[]>(sql`select internal.api_recommendations(${digestOf(token)}) as r`, 'catalog')) ?? [];
  let start = 0;
  if (after) { const index = ranked.findIndex(choice => choice.id === after); if (index < 0) throw new ContractError(['cursor']); start = index + 1; }
  const slice = ranked.slice(start, start + limit);
  const data = { suggested: slice.filter(choice => choice.score > 0), others: slice.filter(choice => choice.score === 0) };
  const nextCursor = start + limit < ranked.length && slice.length ? encodeSqlCursor(slice[slice.length - 1].id) : null;
  return { data, nextCursor };
}
