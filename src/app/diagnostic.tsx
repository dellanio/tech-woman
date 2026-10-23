'use client';
/** Campos do diagnóstico (participante) e do perfil de mentora: estado, validação na ordem da tela e DTO fechado v1. Reutilizáveis nos CRUDs. */
import type { ReactNode } from 'react';
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

export const DISPLAY_NAME_MAX = 120, TRAJECTORY_MAX = 1000, SPECIALTY_MAX = 3, AVAILABILITY_MAX = 300, CAPACITY_MIN = 1, CAPACITY_MAX = 50;
export type MentorDraft = { displayName: string; trajectory: string; specialties: string[]; availability: string; legacyCapacity: string };
export const emptyMentor: MentorDraft = { displayName: '', trajectory: '', specialties: [], availability: '', legacyCapacity: '1' };
export type MentorProfileDto = { displayName: string; trajectory: string; specialties: string[]; availability: string; legacyCapacity: number; consent: true };
export type MentorField = 'displayName' | 'trajectory' | 'specialties' | 'availability' | 'legacyCapacity';
export const MENTOR_MESSAGES: Record<MentorField, string> = {
  displayName: `Informe seu nome de exibição (até ${DISPLAY_NAME_MAX} caracteres).`, trajectory: `Conte sua trajetória (até ${TRAJECTORY_MAX} caracteres).`,
  specialties: `Escolha de 1 a ${SPECIALTY_MAX} especialidades.`, availability: `Descreva sua disponibilidade (até ${AVAILABILITY_MAX} caracteres).`,
  legacyCapacity: `Informe a capacidade legada: um número inteiro de ${CAPACITY_MIN} a ${CAPACITY_MAX}.`,
};
export const MENTOR_IDS: Record<MentorField, string> = { displayName: 'mentor-name', trajectory: 'trajectory', specialties: 'specialty-options', availability: 'availability', legacyCapacity: 'capacity' };
const capacityOf = (raw: string) => /^\d{1,3}$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
const within = (value: string, max: number) => textLength(value) >= 1 && textLength(value) <= max;

/** Ordem da tela; o e-mail (só no público) é validado por quem o exibe. */
export function mentorIssues(d: MentorDraft): Issue<MentorField>[] {
  const bad: MentorField[] = [];
  if (!within(d.displayName, DISPLAY_NAME_MAX)) bad.push('displayName');
  if (!within(d.trajectory, TRAJECTORY_MAX)) bad.push('trajectory');
  if (d.specialties.length < 1 || d.specialties.length > SPECIALTY_MAX) bad.push('specialties');
  if (!within(d.availability, AVAILABILITY_MAX)) bad.push('availability');
  const capacity = capacityOf(d.legacyCapacity);
  if (!(capacity >= CAPACITY_MIN && capacity <= CAPACITY_MAX)) bad.push('legacyCapacity');
  return bad.map(field => ({ field, message: MENTOR_MESSAGES[field] }));
}
export function mentorDto(d: MentorDraft): MentorProfileDto {
  return { displayName: d.displayName.trim(), trajectory: d.trajectory.trim(), specialties: d.specialties, availability: d.availability.trim(), legacyCapacity: capacityOf(d.legacyCapacity), consent: true };
}

/** `email` (opcional) entra logo após o nome, só no cadastro público. */
export function MentorFields({ draft, onChange, invalid, email }: Props<MentorDraft, MentorField> & { email?: ReactNode }) {
  const bad = (f: MentorField) => invalid.includes(f) || undefined;
  return <>
    <label className="field-label" htmlFor={MENTOR_IDS.displayName}>Nome de exibição</label>
    <p className="field-hint" id="mentor-name-hint">Como as participantes vão ver você ao escolher uma mentora.</p>
    <input id={MENTOR_IDS.displayName} value={draft.displayName} onChange={e => onChange({ ...draft, displayName: e.target.value })} maxLength={DISPLAY_NAME_MAX} required autoComplete="name" aria-describedby="mentor-name-hint" aria-invalid={bad('displayName')}/>
    {email}
    <label className="field-label" htmlFor={MENTOR_IDS.trajectory}>Trajetória</label>
    <textarea id={MENTOR_IDS.trajectory} value={draft.trajectory} onChange={e => onChange({ ...draft, trajectory: e.target.value })} maxLength={TRAJECTORY_MAX} required placeholder="Conte brevemente seu percurso em tecnologia" aria-invalid={bad('trajectory')}/>
    <fieldset id={MENTOR_IDS.specialties} className={invalid.includes('specialties') ? 'field-invalid' : undefined}><legend>Em quais áreas você pode contribuir?</legend><p className="field-hint">Escolha até {SPECIALTY_MAX} especialidades.</p>
      <Chips options={topics} values={draft.specialties} max={SPECIALTY_MAX} onChange={specialties => onChange({ ...draft, specialties })} name="specialties"/>
    </fieldset>
    <label className="field-label" htmlFor={MENTOR_IDS.availability}>Disponibilidade descritiva</label>
    <input id={MENTOR_IDS.availability} value={draft.availability} onChange={e => onChange({ ...draft, availability: e.target.value })} maxLength={AVAILABILITY_MAX} required placeholder="Por exemplo: encontros a combinar presencialmente" aria-invalid={bad('availability')}/>
    <label className="field-label" htmlFor={MENTOR_IDS.legacyCapacity}>Capacidade legada (participantes)</label>
    <p className="field-hint" id="capacity-hint">Referência do cadastro anterior, de {CAPACITY_MIN} a {CAPACITY_MAX}; não define vagas de turma.</p>
    <input id={MENTOR_IDS.legacyCapacity} type="number" inputMode="numeric" min={CAPACITY_MIN} max={CAPACITY_MAX} step={1} value={draft.legacyCapacity} onChange={e => onChange({ ...draft, legacyCapacity: e.target.value })} required aria-describedby="capacity-hint" aria-invalid={bad('legacyCapacity')}/>
  </>;
}
