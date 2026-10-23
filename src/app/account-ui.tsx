'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactNode, type Ref } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { DEFAULT_AFTER_LOGIN, Frame, loadSession, loginHref, passwordChangeHref, request, safeNext, type SessionUser, type SessionView } from './shared';

const FLASH = 'tw-auth-flash';
/** Aviso de uma navegação para a próxima tela (troca de senha, reset, saída); lido uma vez e apagado. */
export const setFlash = (value: 'password-set' | 'password-reset' | 'signed-out') => sessionStorage.setItem(FLASH, value);
export function takeFlash(): string | null { const value = sessionStorage.getItem(FLASH); sessionStorage.removeItem(FLASH); return value; }
const PASSWORD_MIN = 12, PASSWORD_MAX = 128;
const ROLE_LABEL: Record<SessionUser['roles'][number], string> = { admin: 'Administração', team: 'Equipe', mentor: 'Mentora', participant: 'Participante' };
const recife = (iso: string) => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Recife', dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
/** Conta caracteres como o backend (code points), não unidades UTF-16. */
const length = (value: string) => [...value].length;

function AuthLayout({ eyebrow, kicker, title, lead, children }: { eyebrow: string; kicker: string; title: ReactNode; lead: ReactNode; children: ReactNode }) {
  return <Frame eyebrow={eyebrow}><div className="admin-login auth-grid"><div className="auth-intro"><p className="eyebrow">{kicker}</p><h1>{title}</h1><p className="hero-lead">{lead}</p></div>{children}</div></Frame>;
}
type FieldProps = { id: string; label: string; hint?: string; ref?: Ref<HTMLInputElement> } & InputHTMLAttributes<HTMLInputElement>;
function Field({ id, label, hint, ref, ...input }: FieldProps) {
  return <><label className="field-label" htmlFor={id}>{label}</label>{hint && <p className="field-hint" id={`${id}-hint`}>{hint}</p>}<input id={id} ref={ref} aria-describedby={hint ? `${id}-hint` : undefined} {...input}/></>;
}
function Checking({ label }: { label: string }) {
  return <div className="form-panel auth-panel" aria-busy="true"><p className="auth-loading" role="status">{label}</p></div>;
}

export function AccountPanel({ user, expiresAt, notice, onSignedOut }: { user: SessionUser; expiresAt: string; notice?: string; onSignedOut: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  async function signOut() {
    setBusy(true); setError('');
    const result = await request<null>('/api/v1/auth/logout', { method: 'POST' });
    setBusy(false);
    if (result.ok) onSignedOut(); else setError(result.message);
  }
  return <section className="form-panel auth-panel account-panel" aria-labelledby="account-title">
    <p className="eyebrow">SESSÃO ATIVA</p><h2 id="account-title">Sua conta</h2>
    {notice && <p className="notice" role="status">{notice}</p>}
    <dl className="account-facts"><div><dt>E-mail</dt><dd>{user.email}</dd></div><div><dt>Perfis</dt><dd>{user.roles.length ? user.roles.map(r => ROLE_LABEL[r]).join(' · ') : 'Nenhum perfil ainda'}</dd></div><div><dt>Sessão válida até</dt><dd>{recife(expiresAt)} <small>(horário de Recife)</small></dd></div></dl>
    {error && <p role="alert" className="visible-error">{error}</p>}
    <div className="auth-actions"><Link className="button-secondary" href="/troca-senha">Trocar senha</Link><button type="button" className="button-quiet" onClick={signOut} disabled={busy}>{busy ? 'Saindo…' : 'Sair da conta'}</button></div>
  </section>;
}

export function LoginView({ next: rawNext }: { next?: string }) {
  const router = useRouter(); const next = safeNext(rawNext);
  const [session, setSession] = useState<SessionView | null>(null), [notice, setNotice] = useState('');
  const [email, setEmail] = useState(''), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const refresh = useCallback(async () => {
    const result = await loadSession();
    if (!result.ok) { setSession({ state: 'anonymous' }); return; }
    if (result.data.state === 'password_change_required') { router.replace(passwordChangeHref(next)); return; }
    // Sessão full não fica no formulário: segue ao destino (padrão: Sua conta).
    if (result.data.state === 'authenticated') { router.replace(next); return; }
    setSession(result.data);
  }, [next, router]);
  useEffect(() => {
    const flash = takeFlash();
    if (flash === 'password-reset') setNotice('Senha redefinida. Entre com a nova senha.');
    if (flash === 'signed-out') setNotice('Você saiu da conta neste navegador.');
    void refresh();
  }, [refresh]);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || !password) { setError('Informe e-mail e senha.'); emailRef.current?.focus(); return; }
    setBusy(true); setError(''); setNotice('');
    const result = await request<{ state: 'authenticated' | 'password_change_required' }>('/api/v1/auth/login', { method: 'POST', body: { email: email.trim(), password }, csrf: false });
    setPassword(''); setBusy(false);
    if (!result.ok) { setError(result.code === 'INVALID_INPUT' ? 'E-mail ou senha não conferem.' : result.message); return; }
    if (result.data.state === 'password_change_required') { router.replace(passwordChangeHref(next)); return; }
    router.replace(next);
  }
  return <AuthLayout eyebrow="CONTA / ACESSO" kicker="SUA CONTA TECH WOMAN" title={<>Seu caminho continua <em>daqui.</em></>} lead="Entre para acompanhar sua participação, escolher mentora e turma e cuidar dos seus dados.">
    {!session || session.state !== 'anonymous' ? <Checking label="Conferindo sua sessão…"/> :
      <form className="form-panel auth-panel" onSubmit={submit} noValidate aria-busy={busy}>
        <p className="eyebrow">ACESSO</p><h2>Entrar</h2>
        {notice && <p className="notice" role="status">{notice}</p>}
        <Field id="login-email" label="E-mail" ref={emailRef} type="email" name="email" autoComplete="email" inputMode="email" maxLength={254} required value={email} onChange={e => setEmail(e.target.value)}/>
        <Field id="login-password" label="Senha" type="password" name="password" autoComplete="current-password" maxLength={1024} required value={password} onChange={e => setPassword(e.target.value)}/>
        {error && <p role="alert" className="visible-error">{error}</p>}
        <button className="button-primary form-main-action" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
        <div className="auth-links"><Link href="/recuperar-senha">Esqueci minha senha</Link><Link href="/inscricao">Quero participar ↗</Link></div>
        <p className="auth-note">Recebeu uma senha temporária? Entre com ela; em seguida você define sua senha definitiva.</p>
      </form>}
  </AuthLayout>;
}

export function PasswordChangeView({ next: rawNext }: { next?: string }) {
  const router = useRouter(); const next = safeNext(rawNext);
  const [session, setSession] = useState<SessionView | null>(null);
  const [current, setCurrent] = useState(''), [fresh, setFresh] = useState(''), [confirm, setConfirm] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { void loadSession().then(result => setSession(result.ok ? result.data : { state: 'anonymous' })); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!current) { setError('Informe sua senha atual ou temporária.'); return; }
    if (length(fresh) < PASSWORD_MIN || length(fresh) > PASSWORD_MAX) { setError(`A nova senha precisa ter de ${PASSWORD_MIN} a ${PASSWORD_MAX} caracteres.`); return; }
    if (fresh !== confirm) { setError('As senhas novas não coincidem.'); return; }
    setBusy(true); setError('');
    const result = await request<{ state: 'authenticated' }>('/api/v1/auth/password/change', { method: 'POST', body: { currentPassword: current, newPassword: fresh } });
    setBusy(false);
    if (result.ok) { setCurrent(''); setFresh(''); setConfirm(''); if (next === DEFAULT_AFTER_LOGIN) setFlash('password-set'); router.replace(next); return; }
    if (result.code === 'AUTH_REQUIRED') { setCurrent(''); setSession({ state: 'anonymous' }); return; }
    setError(result.code === 'INVALID_CREDENTIALS' ? 'Senha atual ou temporária não confere.' : result.code === 'INVALID_INPUT' ? `A nova senha precisa ter de ${PASSWORD_MIN} a ${PASSWORD_MAX} caracteres.` : result.message);
  }
  const limited = session?.state === 'password_change_required';
  return <AuthLayout eyebrow="CONTA / SENHA" kicker={limited ? 'ATIVAÇÃO DA CONTA' : 'SEGURANÇA DA CONTA'} title={<>Defina sua senha <em>definitiva.</em></>} lead={limited ? 'Você entrou com uma senha temporária. Para liberar sua conta, escolha agora a senha que vai usar daqui em diante.' : 'Troque sua senha quando quiser. As outras sessões abertas serão encerradas.'}>
    {!session ? <Checking label="Conferindo sua sessão…"/> : session.state === 'anonymous' ?
      <div className="form-panel auth-panel"><p className="eyebrow">SESSÃO ENCERRADA</p><h2>Entre novamente</h2><p role="status" className="auth-note">Sua sessão para trocar a senha não está ativa ou venceu. Entre de novo com a senha temporária ou com a sua senha.</p><Link className="button-primary form-main-action" href={loginHref(next)}>Ir para o acesso</Link></div> :
      <form className="form-panel auth-panel" onSubmit={submit} noValidate aria-busy={busy}>
        <p className="eyebrow">{limited ? 'SENHA TEMPORÁRIA → DEFINITIVA' : 'NOVA SENHA'}</p><h2>Nova senha</h2>
        <Field id="current-password" label="Senha atual ou temporária" type="password" name="currentPassword" autoComplete="current-password" maxLength={1024} required value={current} onChange={e => setCurrent(e.target.value)}/>
        <Field id="new-password" label="Nova senha" hint={`De ${PASSWORD_MIN} a ${PASSWORD_MAX} caracteres. Pode colar de um gerenciador de senhas.`} type="password" name="newPassword" autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} required value={fresh} onChange={e => setFresh(e.target.value)}/>
        <Field id="confirm-password" label="Confirme a nova senha" type="password" name="confirmPassword" autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} required value={confirm} onChange={e => setConfirm(e.target.value)}/>
        {error && <p role="alert" className="visible-error">{error}</p>}
        <button className="button-primary form-main-action" disabled={busy}>{busy ? 'Salvando…' : 'Salvar nova senha'}</button>
      </form>}
  </AuthLayout>;
}

/** `simulated`: ambiente sem SES configurado (decidido no servidor). 202 nunca prova envio nem entrega. */
export function ForgotView({ simulated }: { simulated: boolean }) {
  const [email, setEmail] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [received, setReceived] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim()) { setError('Informe o e-mail da sua conta.'); return; }
    setBusy(true); setError('');
    const result = await request<{ status: 'received' }>('/api/v1/auth/password/forgot', { method: 'POST', body: { email: email.trim() }, csrf: false });
    setBusy(false);
    if (result.ok) { setReceived(true); setEmail(''); return; }
    setError(result.code === 'INVALID_INPUT' ? 'Confira o e-mail informado.' : result.message);
  }
  return <AuthLayout eyebrow="CONTA / RECUPERAÇÃO" kicker="RECUPERAR ACESSO" title={<>Vamos retomar <em>seu acesso.</em></>} lead="Informe o e-mail da sua conta. Se ela puder receber instruções, preparamos um código de uso único ou uma senha temporária.">
    {received ?
      <div className="form-panel auth-panel"><p className="eyebrow">PEDIDO REGISTRADO</p>
        <div role="status"><h2>Solicitação recebida.</h2><p className="auth-note">Se houver uma conta elegível para este e-mail, as instruções de acesso foram preparadas. Esta confirmação não confirma envio nem entrega de mensagem.</p>{simulated && <p className="mock-banner auth-mock">NÃO ENVIADA — ambiente local de simulação: nenhum e-mail sai daqui.</p>}</div>
        <p className="auth-note">Recebeu um código? Use-o para definir a nova senha. Recebeu uma senha temporária? Entre com ela. Se chegar mais de uma mensagem, use a mais recente.</p>
        <div className="auth-links"><Link href="/redefinir-senha">Já tenho um código</Link><Link href="/login">Voltar ao acesso</Link></div>
        <button type="button" className="button-quiet auth-again" onClick={() => setReceived(false)}>Fazer outra solicitação</button>
      </div> :
      <form className="form-panel auth-panel" onSubmit={submit} noValidate aria-busy={busy}>
        <p className="eyebrow">ESQUECI MINHA SENHA</p><h2>Recuperar senha</h2>
        <Field id="forgot-email" label="E-mail" type="email" name="email" autoComplete="email" inputMode="email" maxLength={254} required value={email} onChange={e => setEmail(e.target.value)}/>
        {error && <p role="alert" className="visible-error">{error}</p>}
        <button className="button-primary form-main-action" disabled={busy}>{busy ? 'Solicitando…' : 'Solicitar redefinição'}</button>
        <div className="auth-links"><Link href="/redefinir-senha">Já tenho um código</Link><Link href="/login">Voltar ao acesso</Link></div>
      </form>}
  </AuthLayout>;
}

/** Token do link (?token= ou #token=) fica só num ref em memória: sai da URL no primeiro render e nunca vai ao DOM. */
export function ResetView() {
  const router = useRouter();
  const token = useRef<string | null>(null);
  const [fromLink, setFromLink] = useState<boolean | null>(null);
  const [code, setCode] = useState(''), [fresh, setFresh] = useState(''), [confirm, setConfirm] = useState(''), [error, setError] = useState(''), [invalid, setInvalid] = useState(false), [busy, setBusy] = useState(false);
  useEffect(() => {
    const capture = () => {
      const value = new URLSearchParams(window.location.search).get('token') ?? new URLSearchParams(window.location.hash.slice(1)).get('token');
      if (value) {
        token.current = value; window.history.replaceState(null, '', '/redefinir-senha');
        // O payload inline do Next (já executado) repete a URL pedida; remove os scripts que contêm o token.
        const forms = [value, encodeURIComponent(value)];
        for (const script of document.querySelectorAll('script:not([src])')) if (forms.some(f => script.textContent?.includes(f))) script.remove();
        setCode(''); setError(''); setInvalid(false);
      }
      setFromLink(current => !!value || (current ?? false));
    };
    capture();
    // Link aberto com a página já carregada muda só o fragmento: sem novo render do servidor.
    window.addEventListener('hashchange', capture);
    return () => window.removeEventListener('hashchange', capture);
  }, []);
  const manual = () => { token.current = null; setFromLink(false); };
  async function submit(event: FormEvent) {
    event.preventDefault();
    const secret = fromLink ? token.current : code.trim();
    if (!secret) { setError('Informe o código de redefinição que você recebeu.'); return; }
    if (length(fresh) < PASSWORD_MIN || length(fresh) > PASSWORD_MAX) { setError(`A nova senha precisa ter de ${PASSWORD_MIN} a ${PASSWORD_MAX} caracteres.`); return; }
    if (fresh !== confirm) { setError('As senhas novas não coincidem.'); return; }
    setBusy(true); setError(''); setInvalid(false);
    const result = await request<null>('/api/v1/auth/password/reset', { method: 'POST', body: { token: secret, newPassword: fresh }, csrf: false });
    setBusy(false);
    if (result.ok) { token.current = null; setCode(''); setFresh(''); setConfirm(''); setFlash('password-reset'); router.replace('/login'); return; }
    if (result.code === 'INVALID_RESET' || result.fields.includes('token')) { setInvalid(true); setCode(''); if (fromLink) manual(); setError(result.code === 'INVALID_RESET' ? result.message : 'Confira o código de redefinição.'); return; }
    setError(result.code === 'INVALID_INPUT' ? `A nova senha precisa ter de ${PASSWORD_MIN} a ${PASSWORD_MAX} caracteres.` : result.message);
  }
  return <AuthLayout eyebrow="CONTA / REDEFINIÇÃO" kicker="NOVA SENHA" title={<>Uma senha nova, <em>só sua.</em></>} lead="Use o código de uso único (válido por 30 minutos) e escolha a nova senha. Depois disso, as sessões abertas são encerradas e você entra de novo.">
    {fromLink === null ? <Checking label="Preparando a redefinição…"/> :
      <form className="form-panel auth-panel" onSubmit={submit} noValidate aria-busy={busy}>
        <p className="eyebrow">CÓDIGO DE USO ÚNICO</p><h2>Redefinir senha</h2>
        {fromLink ? <p className="auth-note auth-linked">Código do link carregado com segurança. <button type="button" className="auth-inline" onClick={manual}>Digitar outro código</button></p> :
          <Field id="reset-code" label="Código de redefinição" hint="Cole o código recebido. Se recebeu mais de um, use o mais recente." type="text" name="token" autoComplete="one-time-code" autoCapitalize="off" spellCheck={false} maxLength={256} required value={code} onChange={e => setCode(e.target.value)}/>}
        <Field id="reset-password" label="Nova senha" hint={`De ${PASSWORD_MIN} a ${PASSWORD_MAX} caracteres. Pode colar de um gerenciador de senhas.`} type="password" name="newPassword" autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} required value={fresh} onChange={e => setFresh(e.target.value)}/>
        <Field id="reset-confirm" label="Confirme a nova senha" type="password" name="confirmPassword" autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={PASSWORD_MAX} required value={confirm} onChange={e => setConfirm(e.target.value)}/>
        {error && <div role="alert" className="visible-error">{error}{invalid && <> <Link href="/recuperar-senha">Solicitar novo código</Link></>}</div>}
        <button className="button-primary form-main-action" disabled={busy}>{busy ? 'Redefinindo…' : 'Redefinir senha'}</button>
        <div className="auth-links"><Link href="/recuperar-senha">Não tenho código</Link><Link href="/login">Voltar ao acesso</Link></div>
      </form>}
  </AuthLayout>;
}
