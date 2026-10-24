'use client';
import { useState } from 'react';
import type { AdminMentorDto } from '@/lib/agenda';
import { request } from '../../shared';
import { MentorFields, MENTOR_IDS, emptyMentor, mentorDto, mentorIssues, type MentorDraft, type MentorField } from '../../diagnostic';
import { CollectionView, useCollection } from './collection';
import { labels } from './labels';
import { CreateForm, DeactivateConfirm, EMAIL_MESSAGE, EditForm, RecordFrame, failureMessage, useRecord, validEmail, type AuthHandler } from './records';
const PATH = '/api/v1/admin/mentors';
type Draft = MentorDraft & { email: string };
type Field = MentorField | 'email';
const IDS: Record<Field, string> = { email: 'mentor-email', ...MENTOR_IDS };
const fieldOf = (f: string): MentorField | null => f in MENTOR_IDS ? f as MentorField : null;
const toDraft = (m: AdminMentorDto): MentorDraft => ({ displayName: m.displayName ?? '', trajectory: m.trajectory, specialties: m.specialties, availability: m.availability, legacyCapacity: String(m.legacyCapacity) });
const fields = (draft: MentorDraft, onChange: (d: MentorDraft) => void, invalid: MentorField[]) => <MentorFields draft={draft} onChange={onChange} invalid={invalid}/>;
const conflicts = { COHORT_IN_USE: 'Esta mentora tem reservas ativas. Cancele essas reservas explicitamente antes de desativar; nada foi alterado.' };
export function MentorsSection({ canWrite, onAuthError }: { canWrite: boolean; onAuthError: AuthHandler }) {
 const list = useCollection<AdminMentorDto>(PATH, onAuthError);
 const [panel, setPanel] = useState<{ kind: 'create' } | { kind: 'edit' | 'deactivate'; id: string } | null>(null);
 const [notice, setNotice] = useState(''), [error, setError] = useState(''), [working, setWorking] = useState('');
 function open(next: typeof panel) { setNotice(''); setError(''); setPanel(next); }
 function done(message: string, item: AdminMentorDto) { list.replace(item); setPanel(null); setNotice(message); }
 async function reactivate(id: string) {
  open(null); setWorking(id);
  const current = await request<AdminMentorDto>(`${PATH}/${id}`);
  const result = current.ok && current.etag ? await request<AdminMentorDto>(`${PATH}/${id}`, { method: 'PATCH', body: { active: true }, ifMatch: current.etag }) : current;
  setWorking('');
  if (result.ok) done('Mentora reativada.', result.data);
  else if (!onAuthError(result.code)) setError(failureMessage(result));
 }
 return <section aria-labelledby="resource-title">
  <div className="dashboard-top"><div><p className="eyebrow">CADASTROS / MENTORIA</p><h1 id="resource-title">Mentoras</h1><p>Trajetória, especialidades e disponibilidade descritiva. A capacidade histórica não define vagas de turma.</p></div></div>
  <div className="admin-toolbar"><button type="button" className="button-quiet" onClick={list.reload}>Atualizar lista</button>{canWrite && panel?.kind !== 'create' && <button type="button" className="button-primary" onClick={() => open({ kind: 'create' })}>Cadastrar mentora</button>}</div>
  {notice && <p role="status" className="notice">{notice}</p>}{error && <p role="alert" className="visible-error">{error}</p>}
  {canWrite && panel?.kind === 'create' && <CreateForm<Draft, Field, AdminMentorDto> title="Nova mentora" path={PATH} initial={{ ...emptyMentor, email: '' }} ids={IDS}
   intro={<p>Cria perfil e conta pendente juntos. A solicitação de acesso fica na fila; nenhum envio ou entrega está comprovado.</p>}
   issues={d => [...(!validEmail(d.email) ? [{ field: 'email' as const, message: EMAIL_MESSAGE }] : []), ...mentorIssues(d)]}
   toBody={d => ({ email: d.email.trim(), ...mentorDto(d) })} fieldOf={f => f === 'email' ? f : fieldOf(f)}
   fields={(d, set, invalid) => <><label className="field-label" htmlFor={IDS.email}>E-mail da mentora</label><input id={IDS.email} type="email" value={d.email} onChange={e => set({ ...d, email: e.target.value })} required aria-invalid={invalid.includes('email') || undefined}/><MentorFields draft={d} onChange={next => set({ ...next, email: d.email })} invalid={invalid.filter((f): f is MentorField => f !== 'email')}/></>}
   onCreated={() => { setPanel(null); setNotice('Mentora cadastrada. Conta pendente; solicitação de acesso na fila, sem entrega comprovada.'); list.reload(); }} onCancel={() => setPanel(null)} onAuthError={onAuthError}/>}
  {canWrite && panel && panel.kind !== 'create' && <MentorRecord key={`${panel.kind}-${panel.id}`} id={panel.id} mode={panel.kind} onAuthError={onAuthError} onClose={() => setPanel(null)} onDone={done}/>}
  <CollectionView collection={list} label="Mentoras" noun="mentoras" empty={<><p><strong>Nenhuma mentora cadastrada ainda.</strong></p><p>{canWrite ? 'Use “Cadastrar mentora” para incluir um perfil.' : 'Os cadastros aparecerão aqui para consulta.'}</p></>}>
   {m => { const name = m.displayName || m.email; return <article className="admin-card"><div className="admin-card-head"><h2>{name}</h2><span className="badge">{m.active ? 'Ativa' : 'Desativada'}</span></div><p>{m.email}</p><dl className="admin-facts"><div><dt>Trajetória</dt><dd>{m.trajectory}</dd></div><div><dt>Especialidades</dt><dd>{labels(m.specialties)}</dd></div><div><dt>Disponibilidade descritiva</dt><dd>{m.availability}</dd></div><div><dt>Capacidade histórica</dt><dd>{m.legacyCapacity} · não define vagas de turma</dd></div></dl>{canWrite && <div className="admin-actions"><button type="button" className="button-secondary" aria-label={`Editar ${name}`} onClick={() => open({ kind: 'edit', id: m.id })}>Editar</button>{m.active ? <button type="button" className="button-quiet" aria-label={`Desativar ${name}`} onClick={() => open({ kind: 'deactivate', id: m.id })}>Desativar</button> : <button type="button" className="button-quiet" aria-label={`Reativar ${name}`} onClick={() => void reactivate(m.id)} disabled={working === m.id}>Reativar</button>}</div>}</article>; }}
  </CollectionView>
 </section>;
}
function MentorRecord({ id, mode, onAuthError, onClose, onDone }: { id: string; mode: 'edit' | 'deactivate'; onAuthError: AuthHandler; onClose: () => void; onDone: (message: string, item: AdminMentorDto) => void }) {
 const path = `${PATH}/${id}`, record = useRecord<AdminMentorDto>(path, onAuthError);
 return <RecordFrame state={record.state} reload={() => void record.load()} onClose={onClose} label="mentora">
  {loaded => mode === 'edit' ? <EditForm<AdminMentorDto, MentorDraft, MentorField> title="Editar mentora" path={path} loaded={loaded} reload={record.reloadQuiet} toDraft={toDraft} issues={mentorIssues} toPatch={d => { const { consent: _consent, ...patch } = mentorDto(d); return patch; }} ids={MENTOR_IDS} fields={fields} fieldOf={fieldOf} header={<p className="auth-note">{loaded.item.email}. O e-mail só muda em Usuários, com aviso à conta.</p>} onSaved={item => onDone('Alterações salvas.', item)} onClose={onClose} onAuthError={onAuthError}/>
   : <DeactivateConfirm title="Desativar mentora" path={path} loaded={loaded} reload={record.reloadQuiet} warning={<p>{loaded.item.displayName || loaded.item.email} será desativada. O histórico é preservado. Reservas ativas precisam ser canceladas explicitamente antes.</p>} conflicts={conflicts} onDone={item => onDone('Mentora desativada. Histórico preservado.', item)} onClose={onClose} onAuthError={onAuthError}/>}
 </RecordFrame>;
}
