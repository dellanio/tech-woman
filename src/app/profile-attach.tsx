'use client';
/** Sessão nas telas de cadastro: anônima → cadastro público; limitada → troca obrigatória; full → anexa o perfil à própria conta (/me/profiles). */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { loadSession, passwordChangeHref, type ApiFailure, type SessionUser } from './shared';

export type ProfileSession = { state: 'checking' } | { state: 'anonymous' } | { state: 'authenticated'; user: SessionUser };
export const ACCOUNT_PATH = '/conta';

/** Falha ao ler a sessão (rede) cai no cadastro público: o 202 neutro não revela nem duplica conta existente. */
export function useProfileSession(route: string): ProfileSession {
  const router = useRouter();
  const [session, setSession] = useState<ProfileSession>({ state: 'checking' });
  useEffect(() => {
    let alive = true;
    void loadSession().then(result => {
      if (!alive) return;
      if (result.ok && result.data.state === 'password_change_required') { router.replace(passwordChangeHref(route)); return; }
      setSession(result.ok && result.data.state === 'authenticated' ? { state: 'authenticated', user: result.data.user } : { state: 'anonymous' });
    });
    return () => { alive = false; };
  }, [route, router]);
  return session;
}

/** Erros do anexo que a tela trata sozinha; `null` = mostrar a mensagem padrão do código. */
export function attachOutcome(failure: ApiFailure): 'login' | 'password' | 'exists' | 'refused' | null {
  if (failure.code === 'AUTH_REQUIRED') return 'login';
  if (failure.code === 'PASSWORD_CHANGE_REQUIRED') return 'password';
  if (failure.code === 'PROFILE_EXISTS') return 'exists';
  // 404 do backend (ex.: contas da organização): não expomos o motivo.
  if (failure.code === 'NOT_FOUND') return 'refused';
  return null;
}
export const REFUSED_MESSAGE = 'Esta conta não pode receber este perfil por aqui. Se precisar, fale com a organização do evento.';

export function SignedInAs({ email }: { email: string }) {
  return <p className="signup-account">Este perfil entra na sua conta <strong>{email}</strong>. Não é preciso informar e-mail nem criar senha.</p>;
}
export function ProfileReady({ label, created }: { label: string; created: boolean }) {
  return <>
    <div className="success-panel" role="status"><span className="success-mark">✓</span><p className="eyebrow">{created ? 'PERFIL ADICIONADO' : 'PERFIL EXISTENTE'}</p>
      <h3>{created ? `Perfil de ${label} criado.` : `Você já tem perfil de ${label} nesta conta.`}</h3>
      {label === 'participante' ? <p>Em Sua conta você vai escolher mentora e turma.</p> : <p>Em Sua conta você acompanha seus perfis. Cadastrar o perfil não cria turmas nem horários.</p>}
    </div>
    <Link className="button-primary signup-account-link" href={ACCOUNT_PATH}>Ir para Sua conta ↗</Link>
  </>;
}
