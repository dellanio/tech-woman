'use client';
/** Portão das telas da organização: anônima → acesso, limitada → troca obrigatória, sem papel admin/team → explicação. Só `admin` escreve; `team` lê. */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { authRedirect, loadSession, loginHref, passwordChangeHref, type ApiErrorCode, type SessionUser } from '../../shared';

export type StaffView =
  | { state: 'checking' }
  | { state: 'failed'; message: string }
  | { state: 'denied' }
  | { state: 'ready'; user: SessionUser; canWrite: boolean };

export function useStaffSession(next: string) {
  const router = useRouter();
  const [view, setView] = useState<StaffView>({ state: 'checking' });
  const check = useCallback(async () => {
    setView({ state: 'checking' });
    const result = await loadSession();
    if (!result.ok) { setView({ state: 'failed', message: result.message }); return; }
    if (result.data.state === 'anonymous') { router.replace(loginHref(next)); return; }
    if (result.data.state === 'password_change_required') { router.replace(passwordChangeHref(next)); return; }
    const { user } = result.data;
    if (!user.roles.includes('admin') && !user.roles.includes('team')) { setView({ state: 'denied' }); return; }
    setView({ state: 'ready', user, canWrite: user.roles.includes('admin') });
  }, [next, router]);
  useEffect(() => { void check(); }, [check]);
  /** Erro de sessão vindo de uma chamada do painel (sessão expirou/ficou limitada): segue para o acesso ou a troca. */
  const onAuthError = useCallback((code: ApiErrorCode) => {
    const target = authRedirect(code, next);
    if (target) router.replace(target);
    else if (code === 'FORBIDDEN') setView({ state: 'denied' });
    return target !== null || code === 'FORBIDDEN';
  }, [next, router]);
  return { view, retry: check, onAuthError };
}

/** Estados do portão; `ready` entrega o conteúdo. */
export function StaffGate({ view, retry, children }: { view: StaffView; retry: () => void; children: (ready: Extract<StaffView, { state: 'ready' }>) => ReactNode }) {
  if (view.state === 'checking') return <div className="form-panel auth-panel" aria-busy="true"><p className="auth-loading" role="status">Conferindo sua sessão…</p></div>;
  if (view.state === 'failed') return <div className="form-panel auth-panel"><p role="alert" className="visible-error">{view.message}</p><button type="button" className="button-secondary" onClick={retry}>Tentar novamente</button></div>;
  if (view.state === 'denied') return <section className="form-panel auth-panel admin-denied" aria-labelledby="denied-title">
    <p className="eyebrow">ÁREA DA ORGANIZAÇÃO</p><h1 id="denied-title">Painel restrito à organização</h1>
    <p className="auth-note">Esta área é usada pela organização do evento para cuidar de cadastros e cruzamentos. Seus perfis e reservas ficam em Sua conta.</p>
    <Link className="button-primary form-main-action" href="/conta">Ir para Sua conta ↗</Link>
  </section>;
  return <>{children(view)}</>;
}
