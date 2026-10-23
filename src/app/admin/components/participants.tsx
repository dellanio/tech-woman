'use client';
/** Participantes: lista paginada com os campos úteis do diagnóstico (título = e-mail do cadastro). */
import type { AdminParticipantDto } from '@/lib/agenda';
import type { ApiErrorCode } from '../../shared';
import { CollectionView, useCollection } from './collection';
import { areaLabel, goalLabel, labels, momentLabel } from './labels';

export function ParticipantsSection({ canWrite, onAuthError }: { canWrite: boolean; onAuthError: (code: ApiErrorCode) => boolean }) {
  const list = useCollection<AdminParticipantDto>('/api/v1/admin/participants', onAuthError);
  return <>
    <div className="dashboard-top"><div><p className="eyebrow">CADASTROS / DIAGNÓSTICO</p><h1 id="resource-title">Participantes</h1><p>Objetivo, momento, área, interesses e habilidades de quem se inscreveu. Desativar preserva o histórico.</p></div></div>
    <div className="admin-toolbar">
      <button type="button" className="button-quiet" onClick={list.reload}>Atualizar lista</button>
      {canWrite && <button type="button" className="button-primary">Cadastrar participante</button>}
    </div>
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
      </article>}
    </CollectionView>
  </>;
}
