'use client';
/**
 * Escolha da participante (sessão full v1): sugestões {suggested (score>0), others (score 0)} → mentora → tema/turma (horário de Recife) → resumo → POST /me/enrollments.
 * Só seleção: nada aqui cria tema, turma ou horário. Confirmação só com 201 (inclusive replay idempotente); vagas são informativas e o POST revalida.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { CohortDto, EnrollmentDto } from '@/lib/contracts';
import type { OwnEnrollments } from '@/lib/agenda';
import type { RankedChoice, Recommendations } from '@/lib/recommendations';
import { abilities, authRedirect, errorMessage, newIdempotencyKey, request, topics, type ApiFailure, type ApiResult } from '../shared';

const ACCOUNT = '/conta';
const PAGE_SIZE = 8;
const LABELS = new Map([...topics, ...abilities].map(o => [o.value, o.label]));
/** Razões vêm do ranking no banco com slugs (ex.: "dados", "analise"): exibimos os rótulos da interface. */
const readable = (text: string) => text.replace(/\b[a-z]+\b/g, w => LABELS.get(w) ?? w).replace(/\(\+(\d+)\)/g, '(+$1 pontos)');
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function recifeParts(startsAt: string, endsAt: string, timeZone: string) {
  const day = new Intl.DateTimeFormat('pt-BR', { timeZone, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const hour = new Intl.DateTimeFormat('pt-BR', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const start = new Date(startsAt), end = new Date(endsAt);
  const sameDay = day.format(start) === day.format(end);
  return { date: day.format(start), time: `${hour.format(start)} às ${hour.format(end)}${sameDay ? '' : ` de ${day.format(end)}`}` };
}
function When({ startsAt, endsAt, timeZone }: { startsAt: string; endsAt: string; timeZone: string }) {
  const { date, time } = recifeParts(startsAt, endsAt, timeZone);
  return <><span className="cohort-date">{date}</span><span className="cohort-time">{time} <small>(horário de Recife, {timeZone})</small></span></>;
}
const seats = (c: CohortDto) => c.available > 0 ? `${plural(c.available, 'vaga disponível', 'vagas disponíveis')} de ${c.capacity} · ${plural(c.occupied, 'ocupada', 'ocupadas')}` : `Turma lotada · ${c.occupied} de ${c.capacity} vagas ocupadas`;

/** Foco no título do passo quando ele muda (avanço, conflito ou confirmação); não no primeiro render, para não roubar o foco da página. */
function useStepFocus(key: string) {
  const ref = useRef<HTMLHeadingElement>(null), first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } ref.current?.focus(); }, [key]);
  return ref;
}

// ---- Suas reservas (GET /me/enrollments) ----
const ENROLLMENT_STATUS: Record<EnrollmentDto['status'], string> = { active: 'Ativa', cancelled: 'Cancelada' };
const LEGACY_STATUS: Record<string, string> = { approved: 'Aprovada no cadastro anterior', suggested: 'Sugerida no cadastro anterior', selected: 'Escolhida no cadastro anterior', rejected: 'Não seguiu no cadastro anterior', cancelled: 'Cancelada no cadastro anterior' };

export function MyEnrollments({ version }: { version: number }) {
  const router = useRouter();
  const [data, setData] = useState<OwnEnrollments | null>(null), [error, setError] = useState<ApiFailure | null>(null);
  const load = useCallback(async () => {
    setError(null);
    const result = await request<OwnEnrollments>('/api/v1/me/enrollments');
    if (result.ok) { setData(result.data); return; }
    const to = authRedirect(result.code, ACCOUNT); if (to) { router.replace(to); return; }
    setError(result);
  }, [router]);
  useEffect(() => { void load(); }, [load, version]);
  const enrollments = data ? [...data.enrollments].sort((a, b) => a.startsAt.localeCompare(b.startsAt)) : [];
  return <section className="account-enrollments" aria-labelledby="enrollments-title" aria-busy={!data && !error}>
    <p className="eyebrow">SUAS RESERVAS</p><h2 id="enrollments-title">Suas reservas</h2>
    {error ? <div role="alert" className="visible-error">{error.code === 'IDENTITY_RECONCILIATION_REQUIRED' ? error.message : `Não foi possível carregar suas reservas. ${error.message}`} <button type="button" className="button-quiet" onClick={() => void load()}>Tentar novamente</button></div> :
      !data ? <p role="status" className="auth-loading">Carregando suas reservas…</p> :
      !enrollments.length && !data.legacyMatches.length ? <p className="empty-inline" role="status">Você ainda não tem reservas. Escolha mentora e turma abaixo.</p> :
      <ul className="enrollment-list">
        {enrollments.map(e => <li key={e.id} className={`enrollment-item enrollment-${e.status}`}>
          <strong>{e.topic.name}</strong><span>com {e.mentor.displayName}</span><When startsAt={e.startsAt} endsAt={e.endsAt} timeZone="America/Recife"/><span className="enrollment-status">{ENROLLMENT_STATUS[e.status]}</span>
        </li>)}
        {data.legacyMatches.map(m => <li key={`legacy-${m.id}`} className="enrollment-item enrollment-legacy">
          <strong>Mentoria do cadastro anterior</strong><span>Histórico anterior — sem turma/data/hora registrados</span><span className="enrollment-status">{LEGACY_STATUS[m.status] ?? 'Registro do cadastro anterior'}</span>
        </li>)}
      </ul>}
  </section>;
}

// ---- Jornada de escolha ----
type Step = { step: 'mentors' } | { step: 'cohorts'; mentor: RankedChoice } | { step: 'summary'; mentor: RankedChoice; cohort: CohortDto } | { step: 'done'; mentor: RankedChoice; cohort: CohortDto; enrollment: EnrollmentDto };
type Ranking = { suggested: RankedChoice[]; others: RankedChoice[]; next: string | null };
/** Falhas transitórias: o reenvio usa a mesma chave e o mesmo corpo (o servidor devolve a mesma reserva se a primeira tentativa chegou). */
const TRANSIENT = new Set<ApiFailure['code']>(['NETWORK', 'RETRY_TRANSACTION', 'DEPENDENCY_UNAVAILABLE', 'MAINTENANCE', 'RATE_LIMITED', 'UNEXPECTED']);
const CONFLICT_HINT: Partial<Record<ApiFailure['code'], string>> = {
  COHORT_FULL: 'Outra pessoa reservou a última vaga antes de você.', SCHEDULE_CONFLICT: 'Você já tem outra reserva que coincide com este horário.',
  COHORT_NOT_OPEN: 'A turma deixou de aceitar reservas.', ALREADY_ENROLLED: 'Esta reserva já está em Suas reservas.',
};

async function allCohorts(mentorId: string): Promise<ApiResult<CohortDto[]>> {
  const items: CohortDto[] = []; let cursor: string | null = null;
  for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
    const result: ApiResult<CohortDto[]> = await request<CohortDto[]>(`/api/v1/mentors/${encodeURIComponent(mentorId)}/cohorts?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    if (!result.ok) return result;
    items.push(...result.data);
    if (!result.nextCursor) return { ...result, data: items };
    cursor = result.nextCursor;
  }
  return { ok: true, status: 200, data: items, etag: null, nextCursor: null };
}

export function ChoiceJourney({ simulated, onReserved }: { simulated: boolean; onReserved: () => void }) {
  const router = useRouter();
  const [step, setStep] = useState<Step>({ step: 'mentors' });
  const [ranking, setRanking] = useState<Ranking | null>(null), [rankingError, setRankingError] = useState<ApiFailure | null>(null), [stale, setStale] = useState(false), [loadingMore, setLoadingMore] = useState(false);
  const [cohorts, setCohorts] = useState<CohortDto[] | null>(null), [cohortError, setCohortError] = useState<ApiFailure | null>(null);
  const [topicFilter, setTopicFilter] = useState(''), [selected, setSelected] = useState(''), [selectionNote, setSelectionNote] = useState('');
  const [busy, setBusy] = useState(false), [failure, setFailure] = useState<ApiFailure | null>(null);
  /** Uma chave por tentativa lógica: mesma turma após falha transitória reaproveita; outra turma ou recusa definitiva gera nova. */
  const attempt = useRef<{ cohortId: string; key: string } | null>(null);
  /** Só a leitura mais recente pode atualizar a seleção, inclusive após voltar/trocar mentora. */
  const cohortRequest = useRef(0);
  useEffect(() => () => { cohortRequest.current += 1; }, []);
  const heading = useStepFocus(`${step.step}:${failure?.code ?? ''}`);

  const fail = useCallback((result: ApiFailure) => { const to = authRedirect(result.code, ACCOUNT); if (to) { router.replace(to); return true; } return false; }, [router]);
  const loadRanking = useCallback(async (cursor: string | null) => {
    if (cursor) setLoadingMore(true); else { setRanking(null); setStale(false); }
    setRankingError(null);
    const result = await request<Recommendations>(`/api/v1/me/recommendations?limit=${PAGE_SIZE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    setLoadingMore(false);
    if (!result.ok) {
      if (fail(result)) return;
      // Cursor de mentora que deixou de ser elegível: a lista mudou; recarregar do início.
      if (cursor && result.code === 'INVALID_INPUT' && result.fields.includes('cursor')) { setStale(true); return; }
      setRankingError(result); return;
    }
    setRanking(current => {
      const base = cursor && current ? current : { suggested: [], others: [], next: null };
      const seen = new Set([...base.suggested, ...base.others].map(m => m.id));
      return { suggested: [...base.suggested, ...result.data.suggested.filter(m => !seen.has(m.id))], others: [...base.others, ...result.data.others.filter(m => !seen.has(m.id))], next: result.nextCursor };
    });
  }, [fail]);
  useEffect(() => { void loadRanking(null); }, [loadRanking]);

  const loadCohorts = useCallback(async (mentor: RankedChoice, keep: string) => {
    const requestId = ++cohortRequest.current;
    setCohorts(null); setCohortError(null);
    const result = await allCohorts(mentor.id);
    if (requestId !== cohortRequest.current) return;
    if (!result.ok) { if (!fail(result)) setCohortError(result); return; }
    const list = [...result.data].sort((a, b) => a.startsAt.localeCompare(b.startsAt) || a.id.localeCompare(b.id));
    setCohorts(list);
    const still = list.find(c => c.id === keep);
    if (keep && (!still || still.available <= 0)) { setSelected(''); setSelectionNote(still ? 'A turma que você tinha escolhido está lotada agora. Escolha outra turma.' : 'A turma que você tinha escolhido não está mais disponível. Escolha outra turma.'); }
    else setSelected(keep);
  }, [fail]);
  function openMentor(mentor: RankedChoice) { setFailure(null); setTopicFilter(''); setSelected(''); setSelectionNote(''); setStep({ step: 'cohorts', mentor }); void loadCohorts(mentor, ''); }
  function backToMentors() { cohortRequest.current += 1; setFailure(null); setCohorts(null); setStep({ step: 'mentors' }); void loadRanking(null); }
  function refreshCohorts(mentor: RankedChoice, keep: string) { setFailure(null); setSelectionNote(''); setStep({ step: 'cohorts', mentor }); void loadCohorts(mentor, keep); }

  async function reserve(mentor: RankedChoice, cohort: CohortDto) {
    if (attempt.current?.cohortId !== cohort.id) attempt.current = { cohortId: cohort.id, key: newIdempotencyKey() };
    setBusy(true); setFailure(null);
    const result = await request<EnrollmentDto>('/api/v1/me/enrollments', { method: 'POST', body: { cohortId: cohort.id }, idempotencyKey: attempt.current.key });
    setBusy(false);
    if (result.ok && result.status === 201 && result.data?.cohortId === cohort.id) { attempt.current = null; setStep({ step: 'done', mentor, cohort, enrollment: result.data }); onReserved(); return; }
    const problem: ApiFailure = result.ok ? { ok: false, status: result.status, code: 'UNEXPECTED', message: errorMessage('UNEXPECTED'), fields: [] } : result;
    if (fail(problem)) return;
    if (!TRANSIENT.has(problem.code)) attempt.current = null;
    if (problem.code === 'ALREADY_ENROLLED') onReserved();
    setFailure(problem);
  }

  const mentorCard = (mentor: RankedChoice, suggested: boolean) => <article className="suggestion choice-mentor" key={mentor.id} aria-labelledby={`mentor-${mentor.id}`}>
    <div>
      <p className="eyebrow">{suggested ? 'SUGESTÃO POR AFINIDADE' : 'SEM AFINIDADE CALCULADA'}{mentor.demo && <span className="demo-badge">Demonstração</span>}</p>
      <h3 id={`mentor-${mentor.id}`}>{mentor.displayName}</h3>
      <p>{mentor.trajectory}</p>
      <p className="field-hint">Especialidades: {mentor.specialties.map(s => LABELS.get(s) ?? s).join(' · ')}</p>
    </div>
    {suggested ? <div className="score" aria-label={`Afinidade: ${mentor.score} pontos`}><strong>{mentor.score}</strong><small>PONTOS</small></div> : <div aria-hidden="true"/>}
    {suggested ? <ul aria-label="Motivos da sugestão">{mentor.reasons.map(r => <li key={r}>{readable(r)}</li>)}</ul> :
      <p className="choice-neutral">Seu diagnóstico não tem afinidade calculada com esta mentora. Ela tem turma aberta e pode ser escolhida normalmente.</p>}
    <div className="suggestion-actions"><button type="button" className="button-primary" aria-label={`Ver temas e turmas de ${mentor.displayName}`} onClick={() => openMentor(mentor)}>Ver temas e turmas ↗</button></div>
  </article>;

  const mentorHeader = (mentor: RankedChoice) => <div className="choice-context"><p className="eyebrow">MENTORA ESCOLHIDA</p><p className="choice-context-name">{mentor.displayName}{mentor.demo && <span className="demo-badge">Demonstração</span>}</p><p className="field-hint">{mentor.trajectory}</p></div>;

  return <section className="choices-section choice-journey" aria-labelledby="journey-title">
    <p className="eyebrow">ESCOLHA / MENTORA → TEMA E TURMA → RESERVA</p>
    <h2 id="journey-title">Escolher mentora e turma</h2>
    <ol className="choice-steps" aria-label="Passos da reserva">
      {(['Mentora', 'Tema e turma', 'Conferir e reservar'] as const).map((label, i) => { const current = { mentors: 0, cohorts: 1, summary: 2, done: 2 }[step.step]; return <li key={label} aria-current={i === current ? 'step' : undefined}>{String(i + 1).padStart(2, '0')} · {label}</li>; })}
    </ol>

    {step.step === 'mentors' && <div className="choice-step">
      <h3 ref={heading} tabIndex={-1} className="choice-step-title">Escolha sua mentora</h3>
      <p className="field-hint">As sugestões vêm do seu diagnóstico. Todas as mentoras listadas têm turma aberta; a reserva só acontece quando você confirma a turma.</p>
      {rankingError ? <div role="alert" className="visible-error">{rankingError.code === 'IDENTITY_RECONCILIATION_REQUIRED' || rankingError.code === 'FORBIDDEN' ? rankingError.message : `Não foi possível carregar as mentoras. ${rankingError.message}`} <button type="button" className="button-quiet" onClick={() => void loadRanking(null)}>Tentar novamente</button></div> :
        !ranking ? <p role="status" className="auth-loading" aria-busy="true">Carregando sugestões de mentoras…</p> :
        !ranking.suggested.length && !ranking.others.length ? <p className="empty-inline" role="status">Nenhuma mentora tem turma aberta agora. Volte mais tarde para ver novas turmas.</p> :
        <>
          {ranking.suggested.length > 0 && <div className="choice-group" role="group" aria-labelledby="suggested-title"><h4 id="suggested-title" className="choice-group-title">Sugestões por afinidade <small>({ranking.suggested.length})</small></h4>{ranking.suggested.map(m => mentorCard(m, true))}</div>}
          {ranking.others.length > 0 && <div className="choice-group" role="group" aria-labelledby="others-title"><h4 id="others-title" className="choice-group-title">Outras mentoras com turma aberta <small>({ranking.others.length})</small></h4>{ranking.others.map(m => mentorCard(m, false))}</div>}
          {stale ? <div role="alert" className="visible-error">A lista de mentoras mudou desde que você abriu. <button type="button" className="button-quiet" onClick={() => void loadRanking(null)}>Recarregar sugestões</button></div> :
            ranking.next && <button type="button" className="button-secondary choice-more" disabled={loadingMore} aria-busy={loadingMore} onClick={() => void loadRanking(ranking.next)}>{loadingMore ? 'Carregando…' : 'Carregar mais mentoras'}</button>}
        </>}
    </div>}

    {step.step === 'cohorts' && (() => {
      const mentor = step.mentor;
      const topicNames = cohorts ? [...new Map(cohorts.map(c => [c.topic.id, c.topic.name])).entries()] : [];
      const visible = cohorts?.filter(c => !topicFilter || c.topic.id === topicFilter) ?? [];
      const groups = topicNames.filter(([id]) => !topicFilter || id === topicFilter).map(([id, name]) => ({ id, name, items: visible.filter(c => c.topic.id === id) }));
      const chosen = cohorts?.find(c => c.id === selected && c.available > 0);
      return <div className="choice-step">
        {mentorHeader(mentor)}
        <h3 ref={heading} tabIndex={-1} className="choice-step-title">Escolha o tema e a turma</h3>
        {cohortError ? <div role="alert" className="visible-error">{cohortError.code === 'NOT_FOUND' ? 'Esta mentora não está mais disponível para escolha.' : `Não foi possível carregar as turmas. ${cohortError.message}`} {cohortError.code !== 'NOT_FOUND' && <button type="button" className="button-quiet" onClick={() => void loadCohorts(mentor, selected)}>Tentar novamente</button>}</div> :
          !cohorts ? <p role="status" className="auth-loading" aria-busy="true">Carregando turmas…</p> :
          !cohorts.length ? <p className="empty-inline" role="status">{mentor.displayName} não tem turma aberta no momento. Escolha outra mentora ou volte mais tarde.</p> :
          <>
            {topicNames.length > 1 && <><label className="field-label" htmlFor="topic-filter">Filtrar por tema</label>
              <select id="topic-filter" value={topicFilter} onChange={e => setTopicFilter(e.target.value)}><option value="">Todos os temas ({cohorts.length} turmas)</option>{topicNames.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></>}
            {selectionNote && <p role="status" className="notice">{selectionNote}</p>}
            {groups.map(group => <fieldset key={group.id} className="cohort-group"><legend>{group.name}</legend>
              {group.items.map(c => <label key={c.id} className={`cohort-option${c.available <= 0 ? ' cohort-full' : ''}`}>
                <input type="radio" name="cohort" value={c.id} checked={selected === c.id} disabled={c.available <= 0} onChange={() => { setSelected(c.id); setSelectionNote(''); }}/>
                <span className="cohort-text"><When startsAt={c.startsAt} endsAt={c.endsAt} timeZone={c.timeZone}/><span className="cohort-seats">{seats(c)}</span></span>
              </label>)}
            </fieldset>)}
          </>}
        <div className="suggestion-actions choice-actions">
          <button type="button" className="button-primary" disabled={!chosen} onClick={() => { if (chosen) { setFailure(null); setStep({ step: 'summary', mentor, cohort: chosen }); } }}>Conferir resumo</button>
          <button type="button" className="button-quiet" onClick={() => void loadCohorts(mentor, selected)}>Atualizar horários</button>
          <button type="button" className="button-quiet" onClick={backToMentors}>Escolher outra mentora</button>
        </div>
      </div>;
    })()}

    {step.step === 'summary' && (() => {
      const { mentor, cohort } = step; const { date, time } = recifeParts(cohort.startsAt, cohort.endsAt, cohort.timeZone);
      const conflict = failure && !TRANSIENT.has(failure.code) ? failure : null, transient = failure && TRANSIENT.has(failure.code) ? failure : null;
      return <div className="choice-step">
        <h3 ref={heading} tabIndex={-1} className="choice-step-title">Confira sua reserva</h3>
        <dl className="account-facts choice-summary">
          <div><dt>Mentora</dt><dd>{mentor.displayName}</dd></div>
          <div><dt>Tema</dt><dd>{cohort.topic.name}</dd></div>
          <div><dt>Data</dt><dd>{date}</dd></div>
          <div><dt>Horário</dt><dd>{time} <small>(horário de Recife, {cohort.timeZone})</small></dd></div>
          <div><dt>Vagas quando você abriu</dt><dd>{seats(cohort)}</dd></div>
        </dl>
        {conflict ? <div role="alert" className="visible-error choice-conflict"><p><strong>{errorMessage(conflict.code)} A reserva não foi feita.</strong></p>{CONFLICT_HINT[conflict.code] && <p>{CONFLICT_HINT[conflict.code]}</p>}<p>Sua escolha de mentora continua aqui: atualize os horários ou escolha outra mentora.</p></div> :
          transient && <div role="alert" className="visible-error"><p>{transient.message} Sua escolha foi mantida; se a primeira tentativa chegou, a mesma reserva é devolvida.</p></div>}
        <p className="field-hint">A reserva é confirmada na hora, sem etapa de aprovação, se a vaga ainda estiver livre.</p>
        <div className="suggestion-actions choice-actions">
          {!conflict && <button type="button" className="button-primary" disabled={busy} aria-busy={busy} onClick={() => void reserve(mentor, cohort)}>{busy ? 'Reservando…' : transient ? 'Tentar novamente' : 'Reservar vaga'}</button>}
          <button type="button" className={conflict ? 'button-primary' : 'button-quiet'} disabled={busy} onClick={() => refreshCohorts(mentor, cohort.id)}>Atualizar horários</button>
          <button type="button" className="button-quiet" disabled={busy} onClick={backToMentors}>Escolher outra mentora</button>
        </div>
      </div>;
    })()}

    {step.step === 'done' && (() => {
      const { mentor, cohort, enrollment } = step; const { date, time } = recifeParts(enrollment.startsAt, enrollment.endsAt, cohort.timeZone);
      return <div className="choice-step">
        <div className="success-panel" role="status"><span className="success-mark" aria-hidden="true">✓</span><p className="eyebrow">RESERVA FEITA</p>
          <h3 ref={heading} tabIndex={-1} className="choice-step-title">Reserva confirmada</h3>
          <p><strong>{cohort.topic.name}</strong> com {mentor.displayName}, {date}, {time} (horário de Recife).</p>
          <p>Um e-mail com os dados da reserva entrou na fila de envio. Estar na fila não confirma entrega: sua reserva continua valendo mesmo se o e-mail falhar e fica sempre em Suas reservas.</p>
          {simulated && <p className="mock-banner auth-mock">NÃO ENVIADA — ambiente local de simulação: nenhum e-mail sai daqui.</p>}
        </div>
        <div className="suggestion-actions choice-actions"><button type="button" className="button-secondary" onClick={backToMentors}>Fazer outra reserva</button></div>
      </div>;
    })()}
  </section>;
}
