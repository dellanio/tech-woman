'use client';
/** Campos do diagnóstico (participante) e do perfil de mentora: estado, validação na ordem da tela e DTO fechado v1. Reutilizáveis nos CRUDs. */
import { Chips, abilities, topics } from './shared';

export type Goal = 'transition' | 'growth' | 'leadership';
export type Moment = 'starting' | 'working' | 'returning';
export const GOALS: { value: Goal; title: string; detail: string }[] = [
  { value: 'transition', title: 'Transição de carreira', detail: 'Explorar uma nova área' },
  { value: 'growth', title: 'Crescimento', detail: 'Dar o próximo passo' },
  { value: 'leadership', title: 'Liderança', detail: 'Ampliar meu impacto' },
];
export const MOMENTS: { value: Moment; label: string }[] = [{ value: 'starting', label: 'Começando' }, { value: 'working', label: 'Em atividade' }, { value: 'returning', label: 'Retomando' }];
export const INTEREST_MAX = 3, SKILL_MAX = 4, OTHER_AREA_MAX = 80;
/** Conta caracteres como o backend (code points, após trim). */
export const textLength = (value: string) => [...value.trim()].length;

export type ParticipantDraft = { goal: Goal | ''; moment: Moment | ''; interests: string[]; skills: string[]; area: string; otherArea: string };
export const emptyParticipant: ParticipantDraft = { goal: '', moment: '', interests: [], skills: [], area: '', otherArea: '' };
export type ParticipantProfileDto = { goal: Goal; moment: Moment; interests: string[]; skills: string[]; area: string; otherArea?: string; consent: true };
export type ParticipantField = 'goal' | 'moment' | 'interests' | 'skills' | 'area' | 'otherArea';
export type Issue<F extends string> = { field: F; message: string };

export const PARTICIPANT_MESSAGES: Record<ParticipantField, string> = {
  goal: 'Escolha seu objetivo principal.', moment: 'Escolha em que momento você está.',
  interests: `Escolha de 1 a ${INTEREST_MAX} temas de interesse.`, skills: `Escolha de 1 a ${SKILL_MAX} habilidades que você já utiliza.`,
  area: 'Selecione sua área de atuação.', otherArea: `Informe qual é a sua área (até ${OTHER_AREA_MAX} caracteres).`,
};
export const PARTICIPANT_IDS: Record<ParticipantField, string> = { goal: 'goal-options', moment: 'moment-options', interests: 'interest-options', skills: 'skill-options', area: 'area', otherArea: 'other-area' };
const TRAJECTORY_FIELDS: ParticipantField[] = ['goal', 'moment'];

/** Problemas na ordem visual; `trajectory` limita à primeira etapa. */
export function participantIssues(d: ParticipantDraft, scope: 'trajectory' | 'all' = 'all'): Issue<ParticipantField>[] {
  const bad: ParticipantField[] = [];
  if (!d.goal) bad.push('goal');
  if (!d.moment) bad.push('moment');
  if (scope === 'all') {
    if (d.interests.length < 1 || d.interests.length > INTEREST_MAX) bad.push('interests');
    if (d.skills.length < 1 || d.skills.length > SKILL_MAX) bad.push('skills');
    if (!d.area) bad.push('area');
    else if (d.area === 'outra' && (textLength(d.otherArea) < 1 || textLength(d.otherArea) > OTHER_AREA_MAX)) bad.push('otherArea');
  }
  return bad.map(field => ({ field, message: PARTICIPANT_MESSAGES[field] }));
}
export const isTrajectoryField = (field: ParticipantField) => TRAJECTORY_FIELDS.includes(field);
/** DTO fechado: `otherArea` só existe quando a área é "outra". */
export function participantDto(d: ParticipantDraft): ParticipantProfileDto {
  if (!d.goal || !d.moment) throw new Error('diagnóstico incompleto');
  return { goal: d.goal, moment: d.moment, interests: d.interests, skills: d.skills, area: d.area, ...(d.area === 'outra' ? { otherArea: d.otherArea.trim() } : {}), consent: true };
}

/** Foca o campo; num grupo (fieldset), a primeira opção habilitada. */
export function focusField(id: string) {
  const el = document.getElementById(id);
  if (!el) return;
  const target = el.matches('input,select,textarea,button') ? el : el.querySelector<HTMLElement>('input:not([disabled]),select,textarea');
  target?.focus();
}

type Props<D, F extends string> = { draft: D; onChange: (next: D) => void; invalid: F[] };

export function TrajectoryFields({ draft, onChange, invalid }: Props<ParticipantDraft, ParticipantField>) {
  return <>
    <fieldset id={PARTICIPANT_IDS.goal} className={invalid.includes('goal') ? 'field-invalid' : undefined}><legend>Qual é seu objetivo principal?</legend><p className="field-hint">Escolha uma opção para continuar.</p>
      <div className="choices">{GOALS.map((item, i) => <label className="choice" key={item.value}><input type="radio" name="goal" value={item.value} checked={draft.goal === item.value} onChange={() => onChange({ ...draft, goal: item.value })}/><span className="choice-number">0{i + 1}</span><span><strong>{item.title}</strong><small>{item.detail}</small></span><span className="choice-indicator" aria-hidden="true"/></label>)}</div>
    </fieldset>
    <fieldset id={PARTICIPANT_IDS.moment} className={`moment-field${invalid.includes('moment') ? ' field-invalid' : ''}`}><legend>Em que momento você está?</legend>
      <div className="moment-options">{MOMENTS.map(x => <label key={x.value}><input type="radio" name="moment" value={x.value} checked={draft.moment === x.value} onChange={() => onChange({ ...draft, moment: x.value })}/><span>{x.label}</span></label>)}</div>
    </fieldset>
  </>;
}

export function InterestFields({ draft, onChange, invalid }: Props<ParticipantDraft, ParticipantField>) {
  return <>
    <fieldset id={PARTICIPANT_IDS.interests} className={invalid.includes('interests') ? 'field-invalid' : undefined}><legend>O que faz parte da sua trajetória?</legend><p className="field-hint">Escolha até {INTEREST_MAX} temas de interesse.</p>
      <Chips name="interest" options={topics} values={draft.interests} max={INTEREST_MAX} onChange={interests => onChange({ ...draft, interests })}/>
    </fieldset>
    <fieldset id={PARTICIPANT_IDS.skills} className={`skill-field${invalid.includes('skills') ? ' field-invalid' : ''}`}><legend>Quais habilidades você já utiliza?</legend><p className="field-hint">Escolha de 1 a {SKILL_MAX}.</p>
      <Chips name="skill" options={abilities} values={draft.skills} max={SKILL_MAX} onChange={skills => onChange({ ...draft, skills })}/>
    </fieldset>
    <label className="field-label" htmlFor={PARTICIPANT_IDS.area}>Sua área de atuação</label>
    <select id={PARTICIPANT_IDS.area} value={draft.area} onChange={e => onChange({ ...draft, area: e.target.value })} required aria-invalid={invalid.includes('area') || undefined}>
      <option value="">Selecione uma área</option>{topics.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}<option value="outra">Outra</option>
    </select>
    {draft.area === 'outra' && <><label className="field-label" htmlFor={PARTICIPANT_IDS.otherArea}>Qual área?</label><input id={PARTICIPANT_IDS.otherArea} value={draft.otherArea} onChange={e => onChange({ ...draft, otherArea: e.target.value })} maxLength={OTHER_AREA_MAX} required aria-invalid={invalid.includes('otherArea') || undefined}/></>}
  </>;
}
