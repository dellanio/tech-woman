'use client';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Frame, loginHref, newIdempotencyKey, request } from '../shared';
import { ProfileArt } from '../components';
import { MentorFields, MENTOR_IDS, MENTOR_MESSAGES, emptyMentor, focusField, mentorDto, mentorIssues, type MentorDraft, type MentorField } from '../diagnostic';

type Field = MentorField | 'email' | 'consent';
const IDS: Record<Field, string> = { ...MENTOR_IDS, email: 'mentor-email', consent: 'mentor-consent' };
const MESSAGES: Record<Field, string> = { ...MENTOR_MESSAGES, email: 'Informe um e-mail válido.', consent: 'Confirme o consentimento para continuar.' };
const validEmail = (value: string) => { const v = value.trim(); return v.length >= 3 && v.length <= 254 && v.split('@').length === 2 && /^[\x21-\x7e]+@[^@\s]+\.[^@\s]+$/.test(v); };
const mentorOnly = (fields: Field[]) => fields.filter((f): f is MentorField => f in MENTOR_IDS);

/** Cadastro de PERFIL de mentora (não é agendamento nem cria turmas). `simulated`: ambiente sem SES. */
export function MentorSignup({ simulated }: { simulated: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const [draft, setDraft] = useState<MentorDraft>(emptyMentor), [email, setEmail] = useState(''), [consent, setConsent] = useState(false);
  const [invalid, setInvalid] = useState<Field[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [done, setDone] = useState(false);
  const attempt = useRef<{ body: string; key: string } | null>(null);
  const keyFor = (body: object) => { const s = JSON.stringify(body); if (attempt.current?.body !== s) attempt.current = { body: s, key: newIdempotencyKey() }; return attempt.current.key; };
  useEffect(() => { fetch('/api/mentor', { cache: 'no-store' }).then(r => r.json()).then((v: { open: boolean }) => setOpen(v.open)).catch(() => setOpen(false)); }, []);

  function show(fields: Field[], message?: string) {
    setInvalid(fields); setError(message ?? (fields.length ? MESSAGES[fields[0]] : ''));
    if (fields.length) requestAnimationFrame(() => focusField(IDS[fields[0]]));
  }
  async function submit(event: FormEvent) {
    event.preventDefault();
    const fields: Field[] = mentorIssues(draft).map(i => i.field);
    if (!validEmail(email)) fields.splice(fields[0] === 'displayName' ? 1 : 0, 0, 'email');
    if (!consent) fields.push('consent');
    if (fields.length) { show(fields); return; }
    const body = { email: email.trim(), ...mentorDto(draft) };
    setBusy(true); show([]);
    const result = await request<{ status: 'received' }>('/api/v1/registrations/mentors', { method: 'POST', body, csrf: false, idempotencyKey: keyFor(body) });
    setBusy(false);
    if (result.ok) { setDone(true); return; }
    if (result.code === 'FORBIDDEN') { setOpen(false); return; }
    const known = result.fields.filter((f): f is Field => f in IDS);
    if (result.code === 'INVALID_INPUT' && known.length) { show(known); return; }
    show([], result.message);
  }

  return <Frame eyebrow="MENTORIA / CADASTRO"><div className="split-form">
    <div>
      <p className="eyebrow">PARA MENTORAS</p>
      <h1>O que você aprendeu pode <em>abrir um caminho.</em></h1>
      <p className="hero-lead">Sua experiência tem potência quando encontra a pergunta certa. Conte sua trajetória e as áreas em que pode contribuir.</p>
      <div className="quiet-note">PERFIL, NÃO AGENDAMENTO <span>↗</span><p>Cadastro até 30/10/2026, 23h59 (Brasília). Este cadastro cria seu perfil de mentora; ele não marca horários nem cria turmas.</p></div>
      {!done && <p className="signup-login">Já tem conta? <Link href={loginHref('/mentora')}>Já tenho conta — entrar</Link></p>}
      <div className="mentor-art" aria-hidden="true"><ProfileArt/></div>
    </div>
    {done ? <div className="form-panel">
      <div className="success-panel" role="status"><span className="success-mark">✓</span><p className="eyebrow">PEDIDO REGISTRADO</p><h2>Cadastro recebido.</h2>
        <p>Se este e-mail puder ser usado, as instruções de acesso com uma senha temporária foram preparadas. Esta confirmação não confirma envio nem entrega de mensagem.</p>
        {simulated && <p className="mock-banner">NÃO ENVIADA — ambiente local de simulação: nenhum e-mail sai daqui.</p>}
        <p>Cadastrar o perfil não cria turmas nem horários.</p>
      </div>
      <p className="field-hint signup-next">Com a senha temporária, entre e defina sua senha definitiva para acompanhar seu perfil em Sua conta.</p>
      <Link className="button-primary" href={loginHref('/conta')}>Entrar na conta ↗</Link>
    </div> : open === null ? <div className="form-panel" role="status">Verificando prazo de inscrição…</div> : !open ? <div className="form-panel success-panel" role="status"><p className="eyebrow">PRAZO ENCERRADO</p><h2>Cadastro encerrado.</h2><p>O cadastro de mentoras terminou em 30 de outubro, às 23h59 (Brasília).</p></div> :
      <form className="form-panel mentor-panel" onSubmit={submit} noValidate aria-busy={busy}>
        <p className="eyebrow">01 / SUA TRAJETÓRIA</p><h2>Apresente sua experiência.</h2>
        <MentorFields draft={draft} onChange={setDraft} invalid={mentorOnly(invalid)} email={<>
          <label className="field-label" htmlFor={IDS.email}>Seu e-mail</label>
          <input id={IDS.email} type="email" autoComplete="email" inputMode="email" maxLength={254} value={email} onChange={e => setEmail(e.target.value)} required placeholder="mentora@exemplo.com" aria-invalid={invalid.includes('email') || undefined}/>
        </>}/>
        <label className="consent"><input id={IDS.consent} type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} aria-invalid={invalid.includes('consent') || undefined}/><span>Concordo em usar estes dados para criar meu perfil de mentora e facilitar conexões no evento.</span></label>
        {error && <p role="alert" className="visible-error">{error}</p>}
        <button className="button-primary form-main-action" disabled={busy}>{busy ? 'Enviando…' : 'Cadastrar perfil ↗'}</button>
      </form>}
  </div></Frame>;
}
