'use client';
/** Sua conta (/conta): sessão full obrigatória; anônima vai ao acesso e limitada à troca obrigatória. */
import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AccountPanel, setFlash, takeFlash } from '../account-ui';
import { DEFAULT_AFTER_LOGIN, Frame, loadSession, loginHref, passwordChangeHref, type SessionUser } from '../shared';

type View = { state: 'checking' } | { state: 'failed'; message: string } | { state: 'ready'; user: SessionUser; expiresAt: string };
const FLASH_NOTICE: Record<string, string> = { 'password-set': 'Senha definida. Sua conta está ativa.' };

export function AccountHome() {
  const router = useRouter();
  const [view, setView] = useState<View>({ state: 'checking' }), [notice, setNotice] = useState('');
  const check = useCallback(async () => {
    setView({ state: 'checking' });
    const result = await loadSession();
    if (!result.ok) { setView({ state: 'failed', message: result.message }); return; }
    if (result.data.state === 'anonymous') { router.replace(loginHref(DEFAULT_AFTER_LOGIN)); return; }
    if (result.data.state === 'password_change_required') { router.replace(passwordChangeHref(DEFAULT_AFTER_LOGIN)); return; }
    setView({ state: 'ready', user: result.data.user, expiresAt: result.data.expiresAt });
  }, [router]);
  useEffect(() => { const flash = takeFlash(); if (flash && FLASH_NOTICE[flash]) setNotice(FLASH_NOTICE[flash]); void check(); }, [check]);
  return <Frame eyebrow="SUA CONTA">
    <div className="account-home">
      <div className="auth-intro account-intro"><p className="eyebrow">TECH WOMAN EM RECIFE</p><h1>Bom ter você <em>por aqui.</em></h1><p className="hero-lead">Seus perfis, suas reservas e seus acessos neste encontro.</p></div>
      {view.state === 'checking' ? <div className="form-panel auth-panel" aria-busy="true"><p className="auth-loading" role="status">Conferindo sua sessão…</p></div> :
        view.state === 'failed' ? <div className="form-panel auth-panel"><p role="alert" className="visible-error">{view.message}</p><button type="button" className="button-secondary" onClick={() => void check()}>Tentar novamente</button></div> :
        <div className="account-columns">
          <AccountPanel user={view.user} expiresAt={view.expiresAt} notice={notice} onSignedOut={() => { setFlash('signed-out'); router.replace('/login'); }}/>
        </div>}
    </div>
  </Frame>;
}
