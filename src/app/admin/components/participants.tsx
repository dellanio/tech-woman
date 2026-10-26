'use client';
/** Participantes: lista paginada com os campos úteis do diagnóstico (título = e-mail do cadastro), cadastro pela organização, edição do diagnóstico e desativação/reativação com leitura individual (ETag) antes. */
import { useState } from 'react';
import type { AdminParticipantDto } from '@/lib/agenda';
import { request, type ApiErrorCode } from '../../shared';
import { GOALS, InterestFields, MOMENTS, PARTICIPANT_IDS, TrajectoryFields, emptyParticipant, participantDto, participantIssues, type ParticipantDraft, type ParticipantField } from '../../diagnostic';
import { CollectionView, useCollection } from './collection';
import { areaLabel, goalLabel, labels, momentLabel } from './labels';
import { CreateForm, DeactivateConfirm, EMAIL_MESSAGE, EditForm, RecordFrame, failureMessage, useRecord, validEmail, type AuthHandler } from './records';

const PATH = '/api/v1/admin/participants';
type CreateDraft = ParticipantDraft & { email: string };
type CreateField = ParticipantField | 'email';
const CREATE_IDS: Record<CreateField, string> = { email: 'participant-email', ...PARTICIPANT_IDS };
const ACTIVE_ENROLLMENTS = 'Esta participante tem reservas ativas. Cancele essas reservas explicitamente antes de desativar; nada foi alterado.';
const asField = (f: string): ParticipantField | null => f in PARTICIPANT_IDS ? f as ParticipantField : null;

function createIssues(d: CreateDraft) {
  return [...(validEmail(d.email) ? [] : [{ field: 'email' as const, message: EMAIL_MESSAGE }]), ...participantIssues(d)];
}
function toDraft(p: AdminParticipantDto): ParticipantDraft {
  return {
    goal: GOALS.find(g => g.value === p.goal)?.value ?? '', moment: MOMENTS.find(m => m.value === p.moment)?.value ?? '',
    interests: p.interests, skills: p.skills, area: p.area ?? '', otherArea: p.otherArea ?? '',
  };
}
/** PATCH fechado: só o diagnóstico (nunca e-mail, consentimento, conta ou versão). */
function toPatch(d: ParticipantDraft) {
  const { consent: _consent, ...profile } = participantDto(d);
  return profile;
}
const fields = (draft: ParticipantDraft, setDraft: (next: ParticipantDraft) => void, invalid: ParticipantField[]) => <>
  <TrajectoryFields draft={draft} onChange={setDraft} invalid={invalid}/>
  <InterestFields draft={draft} onChange={setDraft} invalid={invalid}/>
</>;

type Panel = { kind: 'create' } | { kind: 'edit' | 'deactivate'; id: string } | null;

export function ParticipantsSection({ canWrite, onAuthError }: { canWrite: boolean; onAuthError: (code: ApiErrorCode) => boolean }) {
  const list = useCollection<AdminParticipantDto>(PATH, onAuthError);
  const [panel, setPanel] = useState<Panel>(null), [notice, setNotice] = useState(''), [actionError, setActionError] = useState(''), [working, setWorking] = useState('');
  function open(next: Panel) { setNotice(''); setActionError(''); setPanel(next); }
  function done(message: string, item?: AdminParticipantDto) { if (item) list.replace(item); setPanel(null); setNotice(message); }
  /** Reativar: lê por ID (ETag) e envia só `active:true` com If-Match. */
  async function reactivate(p: AdminParticipantDto) {
    open(null); setWorking(p.id);
    const current = await request<AdminParticipantDto>(`${PATH}/${p.id}`);
    const result = current.ok && current.etag ? await request<AdminParticipantDto>(`${PATH}/${p.id}`, { method: 'PATCH', body: { active: true }, ifMatch: current.etag }) : current;
    setWorking('');
    if (result.ok) { done('Participante reativada.', result.data); return; }
    if (!onAuthError(result.code)) setActionError(failureMessage(result));
  }
  return <section aria-labelledby="resource-title">
    <div className="dashboard-top"><div><p className="eyebrow">CADASTROS / DIAGNÓSTICO</p><h1 id="resource-title">Participantes</h1><p>Objetivo, momento, área, interesses e habilidades de quem se inscreveu. Desativar preserva o histórico.</p></div></div>
    <div className="admin-toolbar">
      <button type="button" className="button-quiet" onClick={list.reload}>Atualizar lista</button>
      {canWrite && panel?.kind !== 'create' && <button type="button" className="button-primary" onClick={() => open({ kind: 'create' })}>Cadastrar participante</button>}
    </div>
    {notice && <p role="status" className="notice">{notice}</p>}
    {actionError && <p role="alert" className="visible-error">{actionError}</p>}
    {canWrite && panel?.kind === 'create' && <CreateForm<CreateDraft, CreateField, AdminParticipantDto>
      title="Nova participante" path={PATH} initial={{ ...emptyParticipant, email: '' }} ids={CREATE_IDS} issues={createIssues}
      toBody={d => ({ email: d.email.trim(), ...participantDto(d) })} fieldOf={f => f === 'email' ? 'email' : asField(f)}
      conflicts={{ EMAIL_UNAVAILABLE: 'Não foi possível usar este e-mail para um novo cadastro. Confira o endereço ou procure a conta em Usuários.' }}
      intro={<p>Cria a conta pendente e o diagnóstico na mesma operação. O acesso temporário entra na fila de envio; isso não comprova envio nem entrega.</p>}
      fields={(d, set, invalid) => <>
        <label className="field-label" htmlFor={CREATE_IDS.email}>E-mail da participante</label>
        <input id={CREATE_IDS.email} type="email" autoComplete="off" value={d.email} onChange={e => set({ ...d, email: e.target.value })} required aria-invalid={invalid.includes('email') || undefined}/>
        {fields(d, next => set({ ...next, email: d.email }), invalid.filter((f): f is ParticipantField => f !== 'email'))}
      </>}
      onCreated={() => { setPanel(null); setNotice('Participante cadastrada. A conta fica pendente até o primeiro acesso; o envio do acesso temporário está na fila, sem entrega comprovada.'); list.reload(); }}
      onCancel={() => setPanel(null)} onAuthError={onAuthError}/>}
    {canWrite && (panel?.kind === 'edit' || panel?.kind === 'deactivate') && <ParticipantRecord key={`${panel.kind}-${panel.id}`} id={panel.id} mode={panel.kind} onAuthError={onAuthError} onClose={() => setPanel(null)} onDone={done}/>}
    <CollectionView collection={list} label="Participantes" noun="participantes" empty={<>
      <p><strong>Nenhuma participante cadastrada ainda.</strong></p>
      <p>As inscrições feitas pelo site aparecem aqui.{canWrite ? ' Para incluir alguém agora, use “Cadastrar participante”.' : ''}</p>
    </>}>
      {p => <article className="admin-card">
        <div className="admin-card-head"><span className="index-label">PARTICIPANTE · {goalLabel(p.goal).toUpperCase()}</span><span className={`badge${p.active ? '' : ' badge-off'}`}>{p.active ? 'Ativa' : 'Desativada'}</span></div>
        <h2>{p.email}</h2>
        <dl className="admin-facts">
          <div><dt>Objetivo</dt><dd>{goalLabel(p.goal)}</dd></div>
          <div><dt>Momento</dt><dd>{momentLabel(p.moment)}</dd></div>
          <div><dt>Área</dt><dd>{areaLabel(p.area, p.otherArea)}</dd></div>
          <div><dt>Interesses</dt><dd>{labels(p.interests)}</dd></div>
          <div><dt>Habilidades</dt><dd>{labels(p.skills)}</dd></div>
          <div><dt>Conta</dt><dd>{p.userId ? 'Vinculada' : 'Sem conta ativa (cadastro anterior)'}</dd></div>
        </dl>
        {canWrite && <div className="admin-actions">
          <button type="button" className="button-secondary" aria-label={`Editar ${p.email}`} onClick={() => open({ kind: 'edit', id: p.id })}>Editar</button>
          {p.active
            ? <button type="button" className="button-quiet" aria-label={`Desativar ${p.email}`} onClick={() => open({ kind: 'deactivate', id: p.id })}>Desativar</button>
            : <button type="button" className="button-quiet" aria-label={`Reativar ${p.email}`} onClick={() => void reactivate(p)} disabled={working === p.id} aria-busy={working === p.id}>{working === p.id ? 'Reativando…' : 'Reativar'}</button>}
        </div>}
      </article>}
    </CollectionView>
  </section>;
}

/** Leitura individual (ETag) e, conforme o modo, edição do diagnóstico ou confirmação da desativação. */
function ParticipantRecord({ id, mode, onAuthError, onClose, onDone }: { id: string; mode: 'edit' | 'deactivate'; onAuthError: AuthHandler; onClose: () => void; onDone: (message: string, item: AdminParticipantDto) => void }) {
  const path = `${PATH}/${id}`;
  const record = useRecord<AdminParticipantDto>(path, onAuthError);
  return <RecordFrame state={record.state} reload={() => void record.load()} onClose={onClose} label="participante">
    {loaded => mode === 'edit'
      ? <EditForm<AdminParticipantDto, ParticipantDraft, ParticipantField> title="Editar participante" path={path} loaded={loaded} reload={record.reloadQuiet}
        toDraft={toDraft} issues={d => participantIssues(d)} toPatch={toPatch} ids={PARTICIPANT_IDS} fields={fields} fieldOf={asField}
        header={<p className="auth-note">Cadastro de <strong>{loaded.item.email}</strong>. O e-mail só muda em Usuários, com aviso à conta.</p>}
        onSaved={item => onDone('Alterações salvas.', item)} onClose={onClose} onAuthError={onAuthError}/>
      : <DeactivateConfirm<AdminParticipantDto> title="Desativar participante" path={path} loaded={loaded} reload={record.reloadQuiet}
        conflicts={{ COHORT_IN_USE: ACTIVE_ENROLLMENTS }}
        warning={<p><strong>{loaded.item.email}</strong> deixa de receber sugestões e não poderá reservar novas turmas. O histórico de reservas e cruzamentos é preservado; reservas ativas precisam ser canceladas antes.</p>}
        onDone={item => onDone('Participante desativada. O histórico foi preservado.', item)} onClose={onClose} onAuthError={onAuthError}/>}
  </RecordFrame>;
}
