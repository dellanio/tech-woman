'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdminMatchDto, AdminMentorDto, AdminParticipantDto } from '@/lib/agenda';
import { request } from '../../shared';
import { CollectionView, useCollection } from './collection';
import { CreateForm, DeactivateConfirm, EditForm, RecordFrame, failureMessage, useRecord, type AuthHandler } from './records';
import { reasonLabel } from './labels';
const PATH = '/api/v1/admin/matches';
const STATUS: Record<AdminMatchDto['status'], string> = { suggested: 'Sugerido', rejected: 'Rejeitado', approved: 'Aprovado', selected: 'Reservado', cancelled: 'Cancelado' };
/** Percorre todas as páginas autorizadas: nomes para leitura e seletores, nunca entrada livre de IDs. Falha não vira lista vazia. */
function useDirectory(onAuthError: AuthHandler) {
 const [state, setState] = useState<{ status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; participants: AdminParticipantDto[]; mentors: AdminMentorDto[] }>({ status: 'loading' });
 const generation = useRef(0);
 const load = useCallback(async () => {
  const mine = ++generation.current; setState({ status: 'loading' });
  async function all<T>(path: string): Promise<T[]> {
   const items: T[] = []; let cursor: string | null = null;
   do { const r = await request<T[]>(`${path}?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`); if (!r.ok) throw r; items.push(...r.data); cursor = r.nextCursor; } while (cursor);
   return items;
  }
  try {
   const [participants, mentors] = await Promise.all([all<AdminParticipantDto>('/api/v1/admin/participants'), all<AdminMentorDto>('/api/v1/admin/mentors')]);
   if (mine === generation.current) setState({ status: 'ready', participants, mentors });
  } catch (e) {
   if (mine !== generation.current) return;
   if (e && typeof e === 'object' && 'ok' in e && e.ok === false && 'code' in e) {
    const failure = e as import('../../shared').ApiFailure;
    if (!onAuthError(failure.code)) setState({ status: 'error', message: failureMessage(failure) });
   } else setState({ status: 'error', message: 'Não foi possível carregar os cadastros. Tente novamente.' });
  }
 }, [onAuthError]);
 useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
 return { state, reload: () => void load() };
}
type MatchDraft = { participantId: string; mentorId: string };
const IDS = { participantId: 'crossing-participant', mentorId: 'crossing-mentor' };
const editable = (m: AdminMatchDto) => m.origin === 'current' && !m.enrollmentId && (m.status === 'suggested' || m.status === 'rejected');
export function MatchesSection({ canWrite, onAuthError }: { canWrite: boolean; onAuthError: AuthHandler }) {
 const list = useCollection<AdminMatchDto>(PATH, onAuthError), directory = useDirectory(onAuthError);
 const [panel, setPanel] = useState<{ kind: 'create' } | { kind: 'edit' | 'cancel'; id: string } | null>(null), [notice, setNotice] = useState('');
 function open(next: typeof panel) { setNotice(''); setPanel(next); }
 function done(message: string, item: AdminMatchDto) { list.replace(item); setPanel(null); setNotice(message); }
 const d = directory.state;
 return <section aria-labelledby="resource-title">
  <div className="dashboard-top"><div><p className="eyebrow">ENCONTROS / HISTÓRICO</p><h1 id="resource-title">Cruzamentos</h1><p>Sugestões calculadas e decisões preservadas. Criar um cruzamento não reserva vaga.</p></div></div>
  <div className="admin-toolbar"><button type="button" className="button-quiet" onClick={() => { list.reload(); directory.reload(); }}>Atualizar lista</button>{canWrite && d.status === 'ready' && panel?.kind !== 'create' && <button type="button" className="button-primary" onClick={() => open({ kind: 'create' })}>Criar cruzamento</button>}</div>
  {notice && <p role="status" className="notice">{notice}</p>}
  {d.status === 'loading' && <p role="status" className="auth-loading">Carregando os nomes dos cadastros…</p>}
  {d.status === 'error' && <div><p role="alert" className="visible-error">{d.message}</p><button type="button" className="button-secondary" onClick={directory.reload}>Tentar novamente</button></div>}
  {d.status === 'ready' && <>
   {canWrite && panel?.kind === 'create' && <CreateForm<MatchDraft, keyof MatchDraft, AdminMatchDto> title="Novo cruzamento" path={PATH} initial={{ participantId: '', mentorId: '' }} ids={IDS} intro={<p>Escolha cadastros ativos. Pontuação e razões são calculadas pelo servidor; a participante reserva pelo próprio acesso.</p>}
    issues={draft => [...(!draft.participantId ? [{ field: 'participantId' as const, message: 'Escolha uma participante.' }] : []), ...(!draft.mentorId ? [{ field: 'mentorId' as const, message: 'Escolha uma mentora.' }] : [])]} toBody={draft => draft}
    fields={(draft, set, invalid) => <><label className="field-label" htmlFor={IDS.participantId}>Participante</label><select id={IDS.participantId} value={draft.participantId} onChange={e => set({ ...draft, participantId: e.target.value })} aria-invalid={invalid.includes('participantId') || undefined}><option value="">Selecione uma participante</option>{d.participants.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.email}</option>)}</select><label className="field-label" htmlFor={IDS.mentorId}>Mentora</label><select id={IDS.mentorId} value={draft.mentorId} onChange={e => set({ ...draft, mentorId: e.target.value })} aria-invalid={invalid.includes('mentorId') || undefined}><option value="">Selecione uma mentora</option>{d.mentors.filter(m => m.active).map(m => <option key={m.id} value={m.id}>{m.displayName || m.email}</option>)}</select>{(!d.participants.some(p => p.active) || !d.mentors.some(m => m.active)) && <p className="auth-note">Cadastre uma participante e uma mentora ativas antes de criar um cruzamento.</p>}</>}
    onCreated={() => { setPanel(null); setNotice('Cruzamento criado. Nenhuma vaga foi reservada.'); list.reload(); }} onCancel={() => setPanel(null)} onAuthError={onAuthError}/>}
   {canWrite && panel && panel.kind !== 'create' && <MatchRecord key={`${panel.kind}-${panel.id}`} id={panel.id} mode={panel.kind} onAuthError={onAuthError} onClose={() => setPanel(null)} onDone={done}/>}
   <CollectionView collection={list} label="Cruzamentos" noun="cruzamentos" empty={<><p><strong>Nenhum cruzamento disponível.</strong></p><p>{canWrite ? 'Crie uma sugestão entre os cadastros autorizados.' : 'As sugestões e o histórico aparecerão aqui para consulta.'}</p></>}>
    {m => <article className="admin-card"><div className="admin-card-head"><h2>{d.participants.find(p => p.id === m.participantId)?.email || 'Participante indisponível'} → {d.mentors.find(t => t.id === m.mentorId)?.displayName || d.mentors.find(t => t.id === m.mentorId)?.email || 'Mentora indisponível'}</h2><span className="badge">{STATUS[m.status]}</span></div><p>{m.origin === 'legacy' ? 'Legado · decisão preservada, sem horário ou turma associados.' : 'Atual · sugestão não reserva vaga.'}</p><dl className="admin-facts"><div><dt>Pontuação calculada</dt><dd>{m.score}</dd></div><div><dt>Razões</dt><dd>{m.reasons.length ? m.reasons.map(reasonLabel).join(' · ') : 'Sem afinidade calculada.'}</dd></div></dl>{m.enrollmentId && <p className="auth-note">Vinculado a uma reserva. Alterações exigem o cancelamento explícito da reserva; este painel preserva o histórico.</p>}{canWrite && <div className="admin-actions">{editable(m) && <button type="button" className="button-secondary" onClick={() => open({ kind: 'edit', id: m.id })}>Editar cruzamento</button>}{!m.enrollmentId && m.status !== 'cancelled' && <button type="button" className="button-quiet" onClick={() => open({ kind: 'cancel', id: m.id })}>Cancelar cruzamento</button>}</div>}</article>}
   </CollectionView>
  </>}
 </section>;
}
function MatchRecord({ id, mode, onAuthError, onClose, onDone }: { id: string; mode: 'edit' | 'cancel'; onAuthError: AuthHandler; onClose: () => void; onDone: (message: string, item: AdminMatchDto) => void }) {
 const path = `${PATH}/${id}`, record = useRecord<AdminMatchDto>(path, onAuthError);
 return <RecordFrame state={record.state} reload={() => void record.load()} onClose={onClose} label="cruzamento">{loaded => {
  if (loaded.item.enrollmentId || (mode === 'edit' && !editable(loaded.item))) return <div className="form-panel"><p role="alert">Esta decisão é somente consulta aqui. Uma reserva vinculada precisa ser cancelada explicitamente.</p><button type="button" className="button-quiet" onClick={onClose}>Fechar</button></div>;
  return mode === 'edit' ? <EditForm<AdminMatchDto, { status: 'suggested' | 'rejected' }, 'status'> title="Editar cruzamento" path={path} loaded={loaded} reload={record.reloadQuiet} toDraft={m => ({ status: m.status === 'rejected' ? 'rejected' : 'suggested' })} issues={() => []} toPatch={draft => draft} ids={{ status: 'crossing-status' }} header={<p>Pontuação {loaded.item.score} e razões calculadas pelo servidor são somente leitura.</p>} fields={(draft, set) => <><label className="field-label" htmlFor="crossing-status">Situação do cruzamento</label><select id="crossing-status" value={draft.status} onChange={e => set({ status: e.target.value === 'rejected' ? 'rejected' : 'suggested' })}><option value="suggested">Sugerido</option><option value="rejected">Rejeitado</option></select></>} onSaved={item => onDone('Alterações salvas.', item)} onClose={onClose} onAuthError={onAuthError}/>
   : <DeactivateConfirm title="Cancelar cruzamento" path={path} loaded={loaded} reload={record.reloadQuiet} warning={<p>O cruzamento será marcado como cancelado. O histórico será preservado; nenhuma reserva será criada ou apagada.</p>} confirmLabel="Confirmar cancelamento" conflicts={{ COHORT_IN_USE: 'Este cruzamento passou a ter uma reserva vinculada. Cancele a reserva explicitamente; nada foi alterado.' }} onDone={item => onDone('Cruzamento cancelado. Histórico preservado.', item)} onClose={onClose} onAuthError={onAuthError}/>;
 }}</RecordFrame>;
}
