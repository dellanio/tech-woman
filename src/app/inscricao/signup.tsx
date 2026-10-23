'use client';
import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Frame, loginHref, newIdempotencyKey, request } from '../shared';
import { ProfileArt } from '../components';
import { InterestFields, TrajectoryFields, PARTICIPANT_IDS, PARTICIPANT_MESSAGES, emptyParticipant, focusField, isTrajectoryField, participantDto, participantIssues, type ParticipantDraft, type ParticipantField } from '../diagnostic';

type Field = ParticipantField | 'email' | 'consent';
const IDS: Record<Field, string> = { ...PARTICIPANT_IDS, email: 'email', consent: 'consent' };
const MESSAGES: Record<Field, string> = { ...PARTICIPANT_MESSAGES, email: 'Informe um e-mail válido.', consent: 'Confirme o consentimento para continuar.' };
/** Mesma regra do contrato v1 (um @, domínio com ponto, ASCII visível). */
const validEmail = (value: string) => { const v = value.trim(); return v.length >= 3 && v.length <= 254 && v.split('@').length === 2 && /^[\x21-\x7e]+@[^@\s]+\.[^@\s]+$/.test(v); };

/** `simulated`: ambiente sem SES (decidido no servidor). O 202 é neutro: nunca prova conta nova, envio nem entrega. */
export function ParticipantSignup({ simulated }: { simulated: boolean }) {
  const [step, setStep] = useState<1 | 2 | 3>(1), [draft, setDraft] = useState<ParticipantDraft>(emptyParticipant);
  const [email, setEmail] = useState(''), [consent, setConsent] = useState(false);
  const [invalid, setInvalid] = useState<Field[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  // Chave estável por tentativa lógica: reenvio do mesmo corpo (ex.: após falha de rede) reutiliza a chave.
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const keyFor = (body: object) => { const s = JSON.stringify(body); if (attempt.current?.body !== s) attempt.current = { body: s, key: newIdempotencyKey() }; return attempt.current.key; };

  function show(fields: Field[], message?: string) {
    setInvalid(fields); setError(message ?? (fields.length ? MESSAGES[fields[0]] : ''));
    if (fields.length) requestAnimationFrame(() => focusField(IDS[fields[0]]));
  }
  function next() {
    const issues = participantIssues(draft, 'trajectory').map(i => i.field);
    if (issues.length) { show(issues); return; }
    show([]); setStep(2);
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const fields: Field[] = participantIssues(draft).map(i => i.field);
    if (!validEmail(email)) fields.push('email');
    if (!consent) fields.push('consent');
    if (fields.length) { if (fields.some(isTrajectoryFieldOf)) setStep(1); show(fields); return; }
    const body = { email: email.trim(), ...participantDto(draft) };
    setBusy(true); show([]);
    const result = await request<{ status: 'received' }>('/api/v1/registrations/participants', { method: 'POST', body, csrf: false, idempotencyKey: keyFor(body) });
    setBusy(false);
    if (result.ok) { setStep(3); return; }
    const known = result.fields.filter((f): f is Field => f in IDS);
    if (result.code === 'INVALID_INPUT' && known.length) { if (known.some(isTrajectoryFieldOf)) setStep(1); show(known); return; }
    show([], result.message);
  }

  return <Frame eyebrow="INSCRIÇÃO / DIAGNÓSTICO">
    <div className="progress-head"><span>DIAGNÓSTICO DE CARREIRA</span><span>{step === 3 ? 'CONCLUÍDO' : `ETAPA 0${step} / 02`}</span></div>
    <div className="progress-track" role="progressbar" aria-label="Progresso da inscrição" aria-valuemin={1} aria-valuemax={2} aria-valuenow={Math.min(step, 2)}><span style={{ width: step === 1 ? '50%' : '100%' }}/></div>
    <div className="wizard-grid form-grid">
      <div className="wizard-intro">
        <span className="section-index">{step === 1 ? '01 — SUA TRAJETÓRIA' : '02 — SEUS INTERESSES'}</span>
        <h2>{step === 1 ? <>Seu próximo <em>movimento</em> começa aqui.</> : step === 2 ? <>Quais caminhos fazem <em>sentido</em> para você?</> : <>Um caminho <em>possível</em> começa aqui.</>}</h2>
        <p>Não existe resposta certa. Suas escolhas ajudam a pensar em encontros relevantes para o seu momento.</p>
        <div className="thread-illustration" aria-hidden="true"><ProfileArt/><small>TRAJETÓRIAS QUE SE ENCONTRAM</small></div>
        <p className="honesty">Encontro presencial · 14 de novembro de 2026<br/>Com a conta ativa, você escolhe mentora e turma.</p>
        {step !== 3 && <p className="signup-login">Já tem conta? <Link href={loginHref('/inscricao')}>Já tenho conta — entrar</Link></p>}
      </div>
      <form className="form-panel" onSubmit={submit} noValidate aria-busy={busy}>
        {step === 1 && <>
          <TrajectoryFields draft={draft} onChange={setDraft} invalid={invalid.filter(isTrajectoryFieldOf)}/>
          <button type="button" className="button-primary form-main-action" onClick={next}>Continuar <span aria-hidden="true">↗</span></button>
        </>}
        {step === 2 && <>
          <InterestFields draft={draft} onChange={setDraft} invalid={invalid.filter((f): f is ParticipantField => f in PARTICIPANT_IDS)}/>
          <label className="field-label" htmlFor={IDS.email}>Seu e-mail</label>
          <input id={IDS.email} type="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} placeholder="voce@exemplo.com" required aria-invalid={invalid.includes('email') || undefined}/>
          <label className="consent"><input id={IDS.consent} type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} aria-invalid={invalid.includes('consent') || undefined}/><span>Concordo em usar minhas respostas e meu e-mail para processar esta inscrição e comunicar o resultado do evento.</span></label>
          <div className="form-actions"><button type="button" className="button-quiet" onClick={() => { setStep(1); show([]); }}>← Voltar</button><button className="button-primary" type="submit" disabled={busy}>{busy ? 'Enviando inscrição…' : 'Enviar inscrição ↗'}</button></div>
        </>}
        {step === 3 && <>
          <div className="success-panel" role="status"><span className="success-mark">✓</span><p className="eyebrow">PEDIDO REGISTRADO</p><h3>Inscrição recebida.</h3>
            <p>Se este e-mail puder ser usado, as instruções de acesso com uma senha temporária foram preparadas. Esta confirmação não confirma envio nem entrega de mensagem.</p>
            {simulated && <p className="mock-banner">NÃO ENVIADA — ambiente local de simulação: nenhum e-mail sai daqui.</p>}
          </div>
          <p className="field-hint signup-next">Com a senha temporária, entre e defina sua senha definitiva. Depois, em Sua conta, você escolhe mentora e turma.</p>
          <Link className="button-primary" href={loginHref('/conta')}>Entrar na conta ↗</Link>
        </>}
        {error && <p className="form-error visible-error" role="alert">{error}</p>}
      </form>
    </div>
  </Frame>;
}
const isTrajectoryFieldOf = (f: Field): f is ParticipantField => f in PARTICIPANT_IDS && isTrajectoryField(f as ParticipantField);
