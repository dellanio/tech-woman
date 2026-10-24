'use client';
import { useEffect, useRef, useState } from 'react';
import type { UserDto } from '@/lib/contracts';
import { InterestFields, TrajectoryFields, MentorFields, PARTICIPANT_IDS, MENTOR_IDS, emptyParticipant, emptyMentor, participantIssues, mentorIssues, participantDto, mentorDto, type ParticipantDraft, type MentorDraft, type ParticipantField, type MentorField, type Issue } from '../../diagnostic';
import { ResendDialog } from './resend';
import { CollectionView, useCollection } from './collection';
import { CreateForm, DeactivateConfirm, EditForm, RecordFrame, useRecord, validEmail, EMAIL_MESSAGE, type AuthHandler } from './records';
const PATH = '/api/v1/admin/users';
type ManagedRole = 'participant' | 'mentor';
const managed = (r: string): r is ManagedRole => r === 'participant' || r === 'mentor';
const roleLabel = (r: string) => r === 'mentor' ? 'Mentora' : r === 'participant' ? 'Participante' : '';
const statusLabel: Record<UserDto['status'], string> = { active: 'Ativa', disabled: 'Desativada', pending_activation: 'Aguardando primeiro acesso' };
const conflicts = { COHORT_IN_USE: 'Há reservas ativas. Cancele-as explicitamente antes de remover perfis ou desativar esta conta; nada foi alterado.' };
type CreateDraft = { email: string; participantEnabled: boolean; mentorEnabled: boolean; participant: ParticipantDraft; mentor: MentorDraft };
type CreateField = 'email' | 'roles' | `participant.${ParticipantField}` | `mentor.${MentorField}`;
const CREATE_IDS = { email: 'user-email', roles: 'user-profiles', ...Object.fromEntries(Object.entries(PARTICIPANT_IDS).map(([k,v]) => [`participant.${k}`,v])), ...Object.fromEntries(Object.entries(MENTOR_IDS).map(([k,v]) => [`mentor.${k}`,v])) } as Record<CreateField, string>;
function createIssues(d: CreateDraft): Issue<CreateField>[] {
 return [ ...(!validEmail(d.email) ? [{ field: 'email' as const, message: EMAIL_MESSAGE }] : []), ...(!d.participantEnabled && !d.mentorEnabled ? [{ field: 'roles' as const, message: 'Escolha ao menos um perfil e preencha seu domínio.' }] : []), ...(d.participantEnabled ? participantIssues(d.participant).map(i => ({ ...i, field: `participant.${i.field}` as CreateField })) : []), ...(d.mentorEnabled ? mentorIssues(d.mentor).map(i => ({ ...i, field: `mentor.${i.field}` as CreateField })) : []) ];
}
function CreateUser({ onCreated, onCancel, onAuthError }: { onCreated: () => void; onCancel: () => void; onAuthError: AuthHandler }) {
 return <CreateForm<CreateDraft, CreateField, UserDto> title="Novo usuário" path={PATH} initial={{ email: '', participantEnabled: true, mentorEnabled: false, participant: emptyParticipant, mentor: emptyMentor }} ids={CREATE_IDS} issues={createIssues} fieldOf={f => f in CREATE_IDS ? f as CreateField : null}
  intro={<p>A conta e os perfis são criados juntos. Preencha os dados com consentimento da pessoa. O acesso fica pendente e a solicitação entra na fila, sem entrega comprovada.</p>}
  toBody={d => ({ email: d.email.trim(), roles: [...(d.participantEnabled ? ['participant'] : []), ...(d.mentorEnabled ? ['mentor'] : [])], ...(d.participantEnabled ? { participant: participantDto(d.participant) } : {}), ...(d.mentorEnabled ? { mentor: mentorDto(d.mentor) } : {}) })}
  fields={(d, set, invalid) => <>
   <label className="field-label" htmlFor="user-email">E-mail da conta</label><input id="user-email" type="email" value={d.email} onChange={e => set({ ...d, email: e.target.value })} required aria-invalid={invalid.includes('email') || undefined}/>
   <fieldset id="user-profiles"><legend>Perfis da conta</legend><p className="field-hint">Cada perfil exige os dados do seu domínio; nenhum papel privilegiado pode ser criado aqui.</p><label><input type="checkbox" checked={d.participantEnabled} onChange={e => set({ ...d, participantEnabled: e.target.checked })}/> Perfil de participante</label><label><input type="checkbox" checked={d.mentorEnabled} onChange={e => set({ ...d, mentorEnabled: e.target.checked })}/> Perfil de mentora</label></fieldset>
   {d.participantEnabled && <section aria-label="Diagnóstico da participante"><h3>Diagnóstico da participante</h3><TrajectoryFields draft={d.participant} onChange={participant => set({ ...d, participant })} invalid={invalid.filter(f => f.startsWith('participant.')).map(f => f.slice(12) as ParticipantField)}/><InterestFields draft={d.participant} onChange={participant => set({ ...d, participant })} invalid={invalid.filter(f => f.startsWith('participant.')).map(f => f.slice(12) as ParticipantField)}/></section>}
   {d.mentorEnabled && <section aria-label="Perfil da mentora"><h3>Perfil da mentora</h3><MentorFields draft={d.mentor} onChange={mentor => set({ ...d, mentor })} invalid={invalid.filter(f => f.startsWith('mentor.')).map(f => f.slice(7) as MentorField)}/></section>}
  </>} onCreated={onCreated} onCancel={onCancel} onAuthError={onAuthError} conflicts={conflicts}/>;
}
type EditDraft = { email: string; status: UserDto['status']; roles: ManagedRole[] };
type EditField = 'email' | 'status' | 'roles';
const EDIT_IDS = { email: 'user-edit-email', status: 'user-edit-status', roles: 'user-edit-roles' };
export function UsersSection({ canWrite, onAuthError }: { canWrite: boolean; onAuthError: AuthHandler }) {
 const list = useCollection<UserDto>(PATH, onAuthError);
 const [panel, setPanel] = useState<{ kind: 'create' } | { kind: 'edit' | 'deactivate' | 'resend'; id: string } | null>(null), [notice, setNotice] = useState('');
 const opener = useRef<HTMLButtonElement | null>(null), restoreFocus = useRef(false);
 useEffect(() => { if (panel === null && restoreFocus.current) { restoreFocus.current = false; opener.current?.focus(); } }, [panel]);
 function closeResend() { restoreFocus.current = true; setPanel(null); }
 function open(next: typeof panel) { setNotice(''); setPanel(next); }
 function done(message: string, item: UserDto) { list.replace(item); setPanel(null); setNotice(message); }
 return <section aria-labelledby="resource-title">
  <div className="dashboard-top"><div><p className="eyebrow">CONTAS / ACESSO</p><h1 id="resource-title">Usuários</h1><p>Contas de participantes e mentoras, com seus perfis vinculados. A desativação preserva os domínios e o histórico.</p></div></div>
  <div className="admin-toolbar"><button type="button" className="button-quiet" onClick={list.reload}>Atualizar lista</button>{canWrite && panel?.kind !== 'create' && <button type="button" className="button-primary" onClick={() => open({ kind: 'create' })}>Cadastrar usuário</button>}</div>
  {notice && <p role="status" className="notice">{notice}</p>}
  {canWrite && panel?.kind === 'create' && <CreateUser onCreated={() => { setPanel(null); setNotice('Usuário cadastrado. Conta e perfis salvos; solicitação de acesso na fila, sem entrega comprovada.'); list.reload(); }} onCancel={() => setPanel(null)} onAuthError={onAuthError}/>}
  {canWrite && panel && panel.kind !== 'create' && <UserRecord key={`${panel.kind}-${panel.id}`} id={panel.id} mode={panel.kind} onAuthError={onAuthError} onClose={panel.kind === 'resend' ? closeResend : () => setPanel(null)} onQueued={() => { closeResend(); setNotice('Solicitação na fila; nenhum envio/entrega comprovados.'); }} onDone={done}/>}
  <CollectionView collection={list} label="Usuários" noun="usuários" empty={<><p><strong>Nenhum usuário disponível.</strong></p><p>{canWrite ? 'Cadastre uma conta com os dados dos perfis de participante ou mentora.' : 'As contas aparecerão aqui para consulta.'}</p></>}>
   {u => <article className="admin-card"><div className="admin-card-head"><h2>{u.email}</h2><span className="status-badge">{statusLabel[u.status]}</span></div><dl className="admin-details"><div><dt>Perfis</dt><dd>{u.roles.filter(managed).map(roleLabel).join(' · ') || 'Sem perfil habilitado'}</dd></div></dl>{canWrite && <div className="admin-actions"><button type="button" className="button-secondary" aria-label={`Editar ${u.email}`} onClick={() => open({ kind: 'edit', id: u.id })}>Editar</button>{u.status !== 'disabled' && <button type="button" className="button-quiet" aria-label={`Reenviar acesso de ${u.email}`} onClick={e => { opener.current = e.currentTarget; open({ kind: 'resend', id: u.id }); }}>Reenviar acesso</button>}{u.status !== 'disabled' && <button type="button" className="button-quiet" aria-label={`Desativar ${u.email}`} onClick={() => open({ kind: 'deactivate', id: u.id })}>Desativar</button>}</div>}</article>}
  </CollectionView>
 </section>;
}
function UserRecord({ id, mode, onAuthError, onClose, onDone, onQueued }: { id: string; mode: 'edit' | 'deactivate' | 'resend'; onAuthError: AuthHandler; onClose: () => void; onDone: (message: string, item: UserDto) => void; onQueued: () => void }) {
 const path = `${PATH}/${id}`, record = useRecord<UserDto>(path, onAuthError);
 return <RecordFrame state={record.state} reload={() => void record.load()} onClose={onClose} label="usuário">{loaded => mode === 'resend' ? <ResendDialog loaded={loaded} onClose={onClose} onQueued={onQueued} onAuthError={onAuthError}/> : mode === 'edit'
  ? <EditForm<UserDto, EditDraft, EditField> title="Editar usuário" path={path} loaded={loaded} reload={record.reloadQuiet} toDraft={u => ({ email: u.email, status: u.status, roles: u.roles.filter(managed) })} issues={d => validEmail(d.email) ? [] : [{ field: 'email', message: EMAIL_MESSAGE }]} ids={EDIT_IDS}
   header={<p className="auth-note">Alterar o e-mail revoga sessões e acessos anteriores e solicita ativação no novo endereço. Remover um papel mantém o domínio e o histórico; não cria nem vincula outro perfil.</p>}
   toPatch={(d, u) => { const patch: { email?: string; status?: 'active' | 'disabled'; roles?: ManagedRole[] } = {}; if (d.email.trim() !== u.email) patch.email = d.email.trim(); if (d.status !== u.status && d.status !== 'pending_activation') patch.status = d.status; if (JSON.stringify(d.roles) !== JSON.stringify(u.roles.filter(managed))) patch.roles = d.roles; return Object.keys(patch).length ? patch : { email: d.email.trim() }; }}
   fields={(d, set, invalid) => <><label className="field-label" htmlFor={EDIT_IDS.email}>E-mail da conta</label><input id={EDIT_IDS.email} type="email" value={d.email} onChange={e => set({ ...d, email: e.target.value })} aria-invalid={invalid.includes('email') || undefined}/><label className="field-label" htmlFor={EDIT_IDS.status}>Situação da conta</label><select id={EDIT_IDS.status} value={d.status} onChange={e => set({ ...d, status: e.target.value === 'disabled' ? 'disabled' : 'active' })}>{loaded.item.status === 'pending_activation' && <option value="pending_activation" disabled>Aguardando primeiro acesso</option>}<option value="active">Ativa</option><option value="disabled">Desativada</option></select><fieldset id={EDIT_IDS.roles}><legend>Perfis já vinculados</legend><p className="field-hint">Só é possível manter ou remover os papéis desta leitura. Novo perfil exige dados de domínio validados, nunca apenas um toggle.</p>{loaded.item.roles.filter(managed).map(role => <label key={role}><input type="checkbox" checked={d.roles.includes(role)} onChange={e => set({ ...d, roles: e.target.checked ? loaded.item.roles.filter(managed).filter(r => d.roles.includes(r) || r === role) : d.roles.filter(r => r !== role) })}/> {role === 'mentor' ? 'Perfil de mentora' : 'Perfil de participante'}</label>)}</fieldset></>}
   onSaved={item => onDone('Alterações salvas. Mudança de e-mail requer novo acesso; fila não comprova entrega.', item)} onClose={onClose} onAuthError={onAuthError} conflicts={conflicts}/>
  : <DeactivateConfirm title="Desativar usuário" path={path} loaded={loaded} reload={record.reloadQuiet} warning={<p>{loaded.item.email} perderá o acesso e suas sessões serão revogadas. Os perfis e o histórico são preservados. Cancele reservas ativas explicitamente antes de continuar.</p>} conflicts={conflicts} onDone={item => onDone('Usuário desativado. Sessões revogadas; histórico preservado.', item)} onClose={onClose} onAuthError={onAuthError}/>}
 </RecordFrame>;
}
