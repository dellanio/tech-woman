'use client';
import { useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { CrossingChoice } from '@/lib/contracts';
import { Frame, authRedirect, loginHref, newIdempotencyKey, request } from '../shared';
import { ProfileArt } from '../components';
import { ProfileReady, REFUSED_MESSAGE, SignedInAs, attachOutcome, useProfileSession } from '../profile-attach';
import { InterestFields, TrajectoryFields, PARTICIPANT_IDS, PARTICIPANT_MESSAGES, emptyParticipant, focusField, isTrajectoryField, participantDto, participantIssues, type ParticipantDraft, type ParticipantField } from '../diagnostic';
import { CrossingStep, type CrossingState } from './crossing';

type Field = ParticipantField | 'email' | 'password' | 'passwordConfirmation' | 'consent';
const IDS: Record<Field, string> = { ...PARTICIPANT_IDS, email: 'email', password: 'password', passwordConfirmation: 'password-confirmation', consent: 'consent' };
const MESSAGES: Record<Field, string> = {
  ...PARTICIPANT_MESSAGES, email: 'Informe um e-mail válido.', password: 'A senha definitiva precisa ter de 12 a 128 caracteres.',
  passwordConfirmation: 'As senhas não conferem.', consent: 'Confirme a declaração para concluir o cadastro.',
};
/** Texto exato pedido pelo sponsor (confirmação final). */
export const FINAL_CONFIRMATION = 'O cadastro da participante na plataforma criará o seu cadastro no sistema, além de já dar carga no cruzamento escolhido por ela.';
/** Mesma regra do contrato v1 (um @, domínio com ponto, ASCII visível). */
const validEmail = (value: string) => { const v = value.trim(); return v.length >= 3 && v.length <= 254 && v.split('@').length === 2 && /^[\x21-\x7e]+@[^@\s]+\.[^@\s]+$/.test(v); };
/** Mesma regra das demais senhas novas: 12 a 128 caracteres (code points). */
const validPassword = (value: string) => [...value].length >= 12 && [...value].length <= 128;
const isChoice = (value: unknown): value is CrossingChoice => !!value && typeof value === 'object' && typeof (value as CrossingChoice).mentor_ref === 'string' && typeof (value as CrossingChoice).nome_exibicao === 'string';
/** Diagnóstico do preview: sem e-mail, credenciais nem consentimento. */
const previewDto = (d: ParticipantDraft) => { const { consent: _consent, ...dto } = participantDto(d); return dto; };

const ROUTE = '/inscricao', PREVIEW = '/api/v1/registrations/participants/preview';
type Step = 1 | 2 | 3 | 4 | 5;
/**
 * Público: 01 trajetória → 02 interesses → 03 crossing (só nomes, troca livre) → 04 e-mail + senha definitiva + confirmação → 05 conclusão neutra.
 * O 202 público nunca prova conta nova; nenhum e-mail é enviado. Com sessão full, o mesmo diagnóstico (sem e-mail) vira perfil da própria conta (01 → 02).
 */
export function ParticipantSignup() {
  const router = useRouter(); const session = useProfileSession(ROUTE);
  const user = session.state === 'authenticated' ? session.user : null;
  const total = user ? 2 : 4;
  const [exists, setExists] = useState(false);
  const [step, setStep] = useState<Step>(1), [draft, setDraft] = useState<ParticipantDraft>(emptyParticipant);
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState(''), [consent, setConsent] = useState(false);
  const [crossing, setCrossing] = useState<CrossingState>({ status: 'idle', key: '' }), [chosen, setChosen] = useState<string | null>(null), [notice, setNotice] = useState('');
  const [invalid, setInvalid] = useState<Field[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  // Chave estável por tentativa lógica: reenvio do mesmo corpo (ex.: após falha de rede) reutiliza a chave.
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const keyFor = (body: object) => { const s = JSON.stringify(body); if (attempt.current?.body !== s) attempt.current = { body: s, key: newIdempotencyKey() }; return attempt.current.key; };
  // Só a resposta do preview mais recente vale: as anteriores (respostas antigas, saída da etapa) são abortadas e ignoradas.
  const sequence = useRef(0), inflight = useRef<AbortController | null>(null);

  function show(fields: Field[], message?: string) {
    setInvalid(fields); setError(message ?? (fields.length ? MESSAGES[fields[0]] : ''));
    if (fields.length) requestAnimationFrame(() => focusField(IDS[fields[0]]));
  }
  function cancelCrossing() { sequence.current++; inflight.current?.abort(); inflight.current = null; }
  async function loadCrossing(force = false) {
    const dto = previewDto(draft), key = JSON.stringify(dto);
    if (!force && crossing.status === 'ready' && crossing.key === key) return;
    cancelCrossing();
    const controller = new AbortController(), mine = sequence.current; inflight.current = controller;
    setCrossing({ status: 'loading', key });
    const result = await request<unknown>(PREVIEW, { method: 'POST', body: dto, csrf: false, signal: controller.signal });
    if (mine !== sequence.current) return;
    inflight.current = null;
    if (!result.ok) { setCrossing({ status: 'error', key, message: result.message }); return; }
    const choices = Array.isArray(result.data) ? result.data.filter(isChoice) : [];
    setCrossing({ status: 'ready', key, choices });
    setChosen(previous => previous && choices.some(c => c.mentor_ref === previous) ? previous : choices[0]?.mentor_ref ?? null);
  }
  function go(next: Step) { if (step === 3 && next !== 3) cancelCrossing(); show([]); setNotice(''); setStep(next); }
  function next() {
    const issues = participantIssues(draft, 'trajectory').map(i => i.field);
    if (issues.length) { show(issues); return; }
    go(2);
  }
  function toCrossing() {
    const issues = participantIssues(draft).map(i => i.field);
    if (issues.length) { if (issues.some(isTrajectoryField)) setStep(1); show(issues); return; }
    go(3); void loadCrossing();
  }
  const choices = crossing.status === 'ready' ? crossing.choices : [];
  const chosenName = choices.find(c => c.mentor_ref === chosen)?.nome_exibicao;

  async function submit(event: FormEvent) {
    event.preventDefault();
    // Enter no meio do assistente público avança como o botão da etapa; só a etapa 04 envia o cadastro
    if (!user && step === 1) { next(); return; }
    if (!user && step === 2) { toCrossing(); return; }
    if (step === 3) return;
    const fields: Field[] = participantIssues(draft).map(i => i.field);
    if (user) {
      if (!consent) fields.push('consent');
      if (fields.length) { if (fields.some(isTrajectoryFieldOf)) setStep(1); show(fields); return; }
      setBusy(true); show([]);
      const result = await request<{ profile: 'participant' }>('/api/v1/me/profiles/participant', { method: 'POST', body: participantDto(draft) });
      setBusy(false);
      if (result.ok) { setStep(5); return; }
      const outcome = attachOutcome(result);
      if (outcome === 'login' || outcome === 'password') { router.replace(authRedirect(result.code, ROUTE) ?? ROUTE); return; }
      if (outcome === 'exists') { setExists(true); return; }
      if (outcome === 'refused') { show([], REFUSED_MESSAGE); return; }
      const known = result.fields.filter((f): f is Field => f in IDS);
      if (result.code === 'INVALID_INPUT' && known.length) { if (known.some(isTrajectoryFieldOf)) setStep(1); show(known); return; }
      show([], result.message); return;
    }
    if (fields.length) { setStep(fields.some(isTrajectoryFieldOf) ? 1 : 2); show(fields); return; }
    if (!chosen || !chosenName) { go(3); void loadCrossing(true); return; }
    if (!validEmail(email)) fields.push('email');
    if (!validPassword(password)) fields.push('password');
    else if (confirmation !== password) fields.push('passwordConfirmation');
    if (!consent) fields.push('consent');
    if (fields.length) { show(fields); return; }
    setBusy(true); show([]);
    const body = { email: email.trim(), ...participantDto(draft), mentor_ref: chosen, password, passwordConfirmation: confirmation };
    const result = await request<{ status: 'received' }>('/api/v1/registrations/participants', { method: 'POST', body, csrf: false, idempotencyKey: keyFor(body) });
    setBusy(false);
    if (result.ok) { setPassword(''); setConfirmation(''); setStep(5); return; }
    if (result.code === 'INVALID_INPUT' && result.fields.includes('mentor_ref')) {
      // a compatibilidade mudou desde o preview: volta ao crossing recalculado, sem perder respostas nem credenciais digitadas
      setStep(3); show([]); setNotice('A mentora escolhida não está mais disponível para estas respostas. Escolha outra mentora compatível.'); void loadCrossing(true); return;
    }
    const known = result.fields.filter((f): f is Field => f in IDS);
    if (result.code === 'INVALID_INPUT' && known.length) { if (known.some(isTrajectoryFieldOf)) setStep(1); else if (known.some(f => f in PARTICIPANT_IDS)) setStep(2); show(known); return; }
    show([], result.message);
  }

  const index = ['', '01 — SUA TRAJETÓRIA', '02 — SEUS INTERESSES', '03 — CRUZAMENTO', '04 — SEU ACESSO', ''][step];
  const title = step === 1 ? <>Seu próximo <em>movimento</em> começa aqui.</> : step === 2 ? <>Quais caminhos fazem <em>sentido</em> para você?</>
    : step === 3 ? <>O cruzamento das suas <em>escolhas</em>.</> : step === 4 ? <>Crie seu <em>acesso</em> definitivo.</> : <>Um caminho <em>possível</em> começa aqui.</>;
  const lead = step === 3 ? 'Mentoras compatíveis com o que você respondeu. Troque à vontade antes de criar o seu acesso.'
    : step === 4 ? 'E-mail e senha ficam por último: a senha que você definir aqui já é a definitiva.' : 'Não existe resposta certa. Suas escolhas ajudam a pensar em encontros relevantes para o seu momento.';
  return <Frame eyebrow="INSCRIÇÃO / DIAGNÓSTICO">
    <div className="progress-head"><span>DIAGNÓSTICO DE CARREIRA</span><span>{step === 5 ? 'CONCLUÍDO' : `ETAPA 0${step} / 0${total}`}</span></div>
    <div className="progress-track" role="progressbar" aria-label="Progresso da inscrição" aria-valuemin={1} aria-valuemax={total} aria-valuenow={Math.min(step, total)}><span style={{ width: `${Math.min(step, total) / total * 100}%` }}/></div>
    <div className="wizard-grid form-grid">
      <div className="wizard-intro">
        {index && <span className="section-index">{index}</span>}
        <h2>{title}</h2>
        <p>{lead}</p>
        <div className="thread-illustration" aria-hidden="true"><ProfileArt/><small>TRAJETÓRIAS QUE SE ENCONTRAM</small></div>
        <p className="honesty">Encontro presencial · 14 de novembro de 2026<br/>{user ? 'Com a conta ativa, você escolhe mentora e turma.' : 'Datas e horários de cada mentora entram depois, na agenda.'}</p>
        {step !== 5 && session.state === 'anonymous' && <p className="signup-login">Já tem conta? <Link href={loginHref('/inscricao')}>Já tenho conta — entrar</Link></p>}
      </div>
      {user && (exists || user.roles.includes('participant')) && step !== 5 ? <div className="form-panel"><ProfileReady label="participante" created={false}/></div> :
      <form className="form-panel" onSubmit={submit} noValidate aria-busy={busy || session.state === 'checking' || crossing.status === 'loading'}>
        {user && step !== 5 && <SignedInAs email={user.email}/>}
        {step === 1 && <>
          <TrajectoryFields draft={draft} onChange={setDraft} invalid={invalid.filter(isTrajectoryFieldOf)}/>
          <button type="button" className="button-primary form-main-action" onClick={next}>Continuar <span aria-hidden="true">↗</span></button>
        </>}
        {step === 2 && <>
          <InterestFields draft={draft} onChange={setDraft} invalid={invalid.filter((f): f is ParticipantField => f in PARTICIPANT_IDS)}/>
          {user && <label className="consent"><input id={IDS.consent} type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} aria-invalid={invalid.includes('consent') || undefined}/><span>Concordo em usar minhas respostas para criar meu perfil de participante e comunicar o resultado do evento.</span></label>}
          <div className="form-actions"><button type="button" className="button-quiet" onClick={() => go(1)}>← Voltar</button>
            {user ? <button className="button-primary" type="submit" disabled={busy || session.state === 'checking'}>{busy ? 'Enviando…' : 'Adicionar perfil de participante ↗'}</button>
              : <button className="button-primary" type="button" onClick={toCrossing} disabled={session.state === 'checking'}>Ver mentoras compatíveis <span aria-hidden="true">↗</span></button>}</div>
        </>}
        {step === 3 && !user && <CrossingStep state={crossing} chosen={chosen} notice={notice} onChoose={ref => { setChosen(ref); setNotice(''); }} onRetry={() => void loadCrossing(true)} onEdit={() => go(2)} onContinue={() => { if (chosen && chosenName) go(4); }}/>}
        {step === 4 && !user && <>
          <div className="choice-context"><p className="eyebrow">CRUZAMENTO ESCOLHIDO</p><p className="choice-context-name">Mentora escolhida: {chosenName}</p>
            <button type="button" className="button-quiet" onClick={() => { go(3); void loadCrossing(); }}>Trocar mentora</button></div>
          <label className="field-label" htmlFor={IDS.email}>Seu e-mail</label>
          <input id={IDS.email} type="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} placeholder="voce@exemplo.com" required aria-invalid={invalid.includes('email') || undefined}/>
          <label className="field-label" htmlFor={IDS.password}>Senha definitiva</label>
          <p className="field-hint" id="password-hint">De 12 a 128 caracteres. É a senha que você vai usar para entrar; não enviamos senha por e-mail.</p>
          <input id={IDS.password} type="password" autoComplete="new-password" maxLength={128} value={password} onChange={e => setPassword(e.target.value)} required aria-describedby="password-hint" aria-invalid={invalid.includes('password') || undefined}/>
          <label className="field-label" htmlFor={IDS.passwordConfirmation}>Confirme a senha</label>
          <input id={IDS.passwordConfirmation} type="password" autoComplete="new-password" maxLength={128} value={confirmation} onChange={e => setConfirmation(e.target.value)} required aria-invalid={invalid.includes('passwordConfirmation') || undefined}/>
          <label className="consent"><input id={IDS.consent} type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} aria-describedby="consent-hint" aria-invalid={invalid.includes('consent') || undefined}/><span>{FINAL_CONFIRMATION}</span></label>
          <p className="field-hint" id="consent-hint">Suas respostas e seu e-mail são usados para processar esta inscrição e comunicar o resultado do evento.</p>
          <div className="form-actions"><button type="button" className="button-quiet" onClick={() => { go(3); void loadCrossing(); }}>← Voltar</button><button className="button-primary" type="submit" disabled={busy}>{busy ? 'Enviando…' : 'Concluir cadastro ↗'}</button></div>
        </>}
        {step === 5 && user && <ProfileReady label="participante" created/>}
        {step === 5 && !user && <>
          <div className="success-panel" role="status"><span className="success-mark">✓</span><p className="eyebrow">PEDIDO REGISTRADO</p><h3>Cadastro concluído.</h3>
            <p>Se este e-mail puder ser usado, sua conta já está ativa com a senha que você definiu, e o cruzamento escolhido foi registrado. Nenhuma mensagem é enviada nesta etapa.</p>
          </div>
          <p className="field-hint signup-next">Entre com seu e-mail e a senha definida. Se este e-mail já tinha cadastro, use a senha que você já tinha ou “Esqueci minha senha”.</p>
          <Link className="button-primary" href={loginHref('/conta')}>Entrar na conta ↗</Link>
        </>}
        {error && <p className="form-error visible-error" role="alert">{error}</p>}
      </form>}
    </div>
  </Frame>;
}
const isTrajectoryFieldOf = (f: Field): f is ParticipantField => f in PARTICIPANT_IDS && isTrajectoryField(f as ParticipantField);
