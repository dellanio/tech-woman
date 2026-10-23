'use client';
/**
 * Escolha da participante (sessão full v1): sugestões {suggested (score>0), others (score 0)} → mentora → tema/turma (horário de Recife) → resumo → POST /me/enrollments.
 * Só seleção: nada aqui cria tema, turma ou horário.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { RankedChoice, Recommendations } from '@/lib/recommendations';
import { abilities, authRedirect, postJson, request, topics, type ApiFailure } from '../shared';

const ACCOUNT = '/conta';
const PAGE_SIZE = 8;
const LABELS = new Map([...topics, ...abilities].map(o => [o.value, o.label]));
/** Razões vêm do ranking no banco com slugs (ex.: "dados", "analise"): exibimos os rótulos da interface. */
const readable = (text: string) => text.replace(/\b[a-z]+\b/g, w => LABELS.get(w) ?? w).replace(/\(\+(\d+)\)/g, '(+$1 pontos)');

/** Foco no título do passo quando ele muda (não no primeiro render, para não roubar o foco da página). */
function useStepFocus(key: string) {
  const ref = useRef<HTMLHeadingElement>(null), first = useRef(true);
  useEffect(() => { if (first.current) { first.current = false; return; } ref.current?.focus(); }, [key]);
  return ref;
}

type Ranking = { suggested: RankedChoice[]; others: RankedChoice[]; next: string | null };

export function ChoiceJourney() {
  const router = useRouter();
  const [ranking, setRanking] = useState<Ranking | null>(null), [rankingError, setRankingError] = useState<ApiFailure | null>(null), [stale, setStale] = useState(false), [loadingMore, setLoadingMore] = useState(false);
  const heading = useStepFocus('mentors');

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
  </article>;

  return <section className="choices-section choice-journey" aria-labelledby="journey-title">
    <p className="eyebrow">ESCOLHA / MENTORA → TEMA E TURMA → RESERVA</p>
    <h2 id="journey-title">Escolher mentora e turma</h2>
    <div className="choice-step">
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
    </div>
  </section>;
}

// ---- Escolha antiga por token (ainda usada pela página de histórico; substituída na fatia do histórico) ----
type Choice={mentorId:string;mentorEmail:string;demo:boolean;trajectory:string;specialties:string[];capacity:number;occupied:number;score:number;reasons:string[]};
type Suggestions={choices:Choice[];assigned:boolean};
export function Choices({token}:{token:string}){
 const [data,setData]=useState<Suggestions|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[chosen,setChosen]=useState(''),[emailStatus,setEmailStatus]=useState('');
 const refresh=useCallback(async()=>{const response=await fetch(`/api/choice/${token}`,{cache:'no-store'});if(response.ok)setData(await response.json() as Suggestions);else setError('Não foi possível atualizar as vagas. Tente novamente.')},[token]);
 useEffect(()=>{void refresh()},[refresh]);
 async function choose(id:string){setBusy(true);setError('');try{const result=await postJson<{mentorEmail:string;emailStatus:string}>(`/api/choice/${token}`,{mentorId:id});setChosen(result.mentorEmail);setEmailStatus(result.emailStatus);await refresh()}catch(e){setError(e instanceof Error?e.message:'Vaga indisponível.');await refresh()}finally{setBusy(false)}}
 return <section className="choices-section" aria-label="Mentoras disponíveis"><p className="eyebrow">MENTORAS COM VAGA / SUAS CONEXÕES</p>{chosen?<div className="notice" role="status"><strong>Mentoria reservada com {chosen}.</strong><p>Sem data ou horário definidos. {emailStatus}</p></div>:data===null?<p role="status">Buscando vagas disponíveis…</p>:data.assigned?<p role="status">Você já reservou uma mentoria. Consulte seu estado individual.</p>:data.choices.length===0?<div className="empty-inline" role="status">Ainda não encontramos mentora compatível com vaga. Sua inscrição permanece na fila para a equipe; volte ao seu link para consultar novas opções.</div>:<><p className="field-hint">Até três opções por compatibilidade. A sugestão não segura a vaga: confirme sua escolha.</p>{data.choices.map(choice=><article className="suggestion choice-mentor" key={choice.mentorId}><div><p className="eyebrow">MENTORA · {choice.occupied} / {choice.capacity} VAGAS OCUPADAS {choice.demo&&<span className="demo-badge">Demonstração</span>}</p><h3>{choice.mentorEmail}</h3><p>{choice.trajectory}</p><p className="field-hint">Aptidões: {choice.specialties.join(' · ')}</p></div><div className="score"><strong>{choice.score}</strong><small>PONTOS</small></div><ul>{choice.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul><button type="button" className="button-primary" disabled={busy} onClick={()=>choose(choice.mentorId)}>{busy?'Confirmando…':'Agendar mentoria ↗'}</button></article>)}</>}{error&&<p className="visible-error" role="alert">{error} <button type="button" className="button-quiet" onClick={()=>void refresh()}>Atualizar opções</button></p>}</section>
}
