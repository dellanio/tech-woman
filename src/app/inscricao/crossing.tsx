'use client';
/** Etapa 03 do cadastro público: mentoras compatíveis (só nome ou "(MENTORA)"), na ordem do ranking, com troca livre. Sem datas, vagas ou pontuação. */
import type { CrossingChoice } from '@/lib/contracts';

export type CrossingState =
  | { status: 'idle' | 'loading'; key: string }
  | { status: 'ready'; key: string; choices: CrossingChoice[] }
  | { status: 'error'; key: string; message: string };

type Props = { state: CrossingState; chosen: string | null; notice: string; onChoose: (ref: string) => void; onRetry: () => void; onEdit: () => void; onContinue: () => void };

export function CrossingStep({ state, chosen, notice, onChoose, onRetry, onEdit, onContinue }: Props) {
  const edit = <button type="button" className="button-quiet" onClick={onEdit}>← Editar respostas</button>;
  if (state.status === 'ready' && state.choices.length === 0) return <>
    <div className="empty-inline" role="status">
      <p><strong>Nenhuma mentora compatível com estas respostas no momento.</strong></p>
      <p>Nada foi cadastrado. Você pode editar suas respostas para ver outras possibilidades de cruzamento.</p>
    </div>
    <div className="form-actions">{edit}</div>
  </>;
  if (state.status === 'ready') return <>
    <fieldset role="radiogroup" aria-labelledby="crossing-legend" className="crossing-options">
      <legend id="crossing-legend">Escolha sua mentora</legend>
      <p className="field-hint">Todas as mentoras compatíveis com as suas escolhas, da mais próxima para a menos próxima. Você pode trocar quando quiser.</p>
      <div className="choices">{state.choices.map((choice, i) => <label className="choice" key={choice.mentor_ref}>
        <input type="radio" name="mentor" value={choice.mentor_ref} checked={chosen === choice.mentor_ref} onChange={() => onChoose(choice.mentor_ref)}/>
        <span className="choice-number" aria-hidden="true">{String(i + 1).padStart(2, '0')}</span>
        <span><strong>{choice.nome_exibicao}</strong></span>
        <span className="choice-indicator" aria-hidden="true"/>
      </label>)}</div>
      <p className="field-hint">Nesta fase mostramos só o nome. Datas e horários entram depois, na agenda de cada mentora.</p>
    </fieldset>
    {notice && <p className="form-error visible-error" role="alert">{notice}</p>}
    <div className="form-actions">{edit}<button type="button" className="button-primary" onClick={onContinue} disabled={!chosen}>Continuar <span aria-hidden="true">↗</span></button></div>
  </>;
  if (state.status === 'error') return <>
    <p className="form-error visible-error" role="alert">{state.message}</p>
    <div className="form-actions">{edit}<button type="button" className="button-primary" onClick={onRetry}>Tentar novamente</button></div>
  </>;
  return <>
    <p className="auth-loading" role="status">Calculando o cruzamento das suas escolhas…</p>
    <div className="form-actions">{edit}</div>
  </>;
}
