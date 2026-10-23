'use client';
/** Sua conta (/conta): sessão full obrigatória; anônima vai ao acesso e limitada à troca obrigatória. O conteúdo segue os papéis: equipe → painel; mentora → próprio perfil (sem Agenda). */
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AccountPanel, setFlash, takeFlash } from '../account-ui';
import { ChoiceJourney, MyEnrollments } from '../inscricao/choices';
import { DEFAULT_AFTER_LOGIN, Frame, loadSession, loginHref, passwordChangeHref, type SessionUser } from '../shared';

type View = { state: 'checking' } | { state: 'failed'; message: string } | { state: 'ready'; user: SessionUser; expiresAt: string };
const FLASH_NOTICE: Record<string, string> = { 'password-set': 'Senha definida. Sua conta está ativa.' };

export function AccountHome({ simulated }: { simulated: boolean }) {
  const router = useRouter();
  const [view, setView] = useState<View>({ state: 'checking' }), [notice, setNotice] = useState('');
  const [enrollmentsVersion, setEnrollmentsVersion] = useState(0);
  const check = useCallback(async () => {
    setView({ state: 'checking' });
    const result = await loadSession();
    if (!result.ok) { setView({ state: 'failed', message: result.message }); return; }
    if (result.data.state === 'anonymous') { router.replace(loginHref(DEFAULT_AFTER_LOGIN)); return; }
    if (result.data.state === 'password_change_required') { router.replace(passwordChangeHref(DEFAULT_AFTER_LOGIN)); return; }
    setView({ state: 'ready', user: result.data.user, expiresAt: result.data.expiresAt });
  }, [router]);
  useEffect(() => { const flash = takeFlash(); if (flash && FLASH_NOTICE[flash]) setNotice(FLASH_NOTICE[flash]); void check(); }, [check]);
  const roles = view.state === 'ready' ? view.user.roles : [];
  const participant = roles.includes('participant'), mentor = roles.includes('mentor'), staff = roles.includes('admin') || roles.includes('team');
  return <Frame eyebrow="SUA CONTA">
    <div className="account-home">
      <div className="auth-intro account-intro"><p className="eyebrow">TECH WOMAN EM RECIFE</p><h1>Bom ter você <em>por aqui.</em></h1><p className="hero-lead">Seus perfis, suas reservas e seus acessos neste encontro.</p></div>
      {view.state === 'checking' ? <div className="form-panel auth-panel" aria-busy="true"><p className="auth-loading" role="status">Conferindo sua sessão…</p></div> :
        view.state === 'failed' ? <div className="form-panel auth-panel"><p role="alert" className="visible-error">{view.message}</p><button type="button" className="button-secondary" onClick={() => void check()}>Tentar novamente</button></div> :
        <div className="account-columns">
          <AccountPanel user={view.user} expiresAt={view.expiresAt} notice={notice} onSignedOut={() => { setFlash('signed-out'); router.replace('/login'); }}/>
          <div className="account-roles">
            {staff && <section className="form-panel account-role" aria-labelledby="staff-title"><p className="eyebrow">ORGANIZAÇÃO</p><h2 id="staff-title">Painel da equipe</h2><p className="auth-note">Sua conta tem acesso de {roles.includes('admin') ? 'administração' : 'equipe'}.</p><Link className="button-primary form-main-action" href="/admin">Abrir painel da equipe ↗</Link></section>}
            {mentor && <section className="form-panel account-role" aria-labelledby="mentor-title"><p className="eyebrow">MENTORIA</p><h2 id="mentor-title">Seu perfil de mentora</h2><p className="auth-note">Seu perfil de mentora está nesta conta. Temas, turmas e horários são definidos pela organização do evento.</p>{!participant && <Link className="text-link" href="/inscricao">Adicionar perfil de participante ↗</Link>}</section>}
            {!participant && !mentor && !staff && <section className="form-panel account-role" aria-labelledby="none-title"><p className="eyebrow">PERFIS</p><h2 id="none-title">Nenhum perfil ainda</h2><div className="auth-links"><Link href="/inscricao">Quero participar ↗</Link><Link href="/mentora">Quero ser mentora ↗</Link></div></section>}
          </div>
        </div>}
      {view.state === 'ready' && participant && <>
        <MyEnrollments version={enrollmentsVersion}/>
        <ChoiceJourney simulated={simulated} onReserved={() => setEnrollmentsVersion(v => v + 1)}/>
      </>}
    </div>
  </Frame>;
}
