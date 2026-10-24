'use client';
/** Painel da organização (/admin): quatro recursos (Participantes, Mentoras, Cruzamentos, Usuários) e o conteúdo textual do evento. Sem Agenda: temas e turmas não são cadastrados aqui. */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { setFlash } from '../../account-ui';
import { Frame, request } from '../../shared';
import { UsersSection } from './users';
import { MatchesSection } from './matches';
import { MentorsSection } from './mentors';
import { ParticipantsSection } from './participants';
import { StaffGate, useStaffSession } from './staff-gate';

const TABS = [
  { key: 'participantes', label: 'Participantes' },
  { key: 'mentoras', label: 'Mentoras' },
  { key: 'cruzamentos', label: 'Cruzamentos' },
  { key: 'usuarios', label: 'Usuários' },
] as const;
type Tab = typeof TABS[number]['key'];
const isTab = (value: string | null): value is Tab => TABS.some(t => t.key === value);

export function AdminPanel() {
  const router = useRouter();
  const { view, retry, onAuthError } = useStaffSession('/admin');
  const [tab, setTab] = useState<Tab>('participantes'), [leaving, setLeaving] = useState(false), [error, setError] = useState('');
  useEffect(() => { const saved = new URLSearchParams(window.location.search).get('aba'); if (isTab(saved)) setTab(saved); }, []);
  function choose(next: Tab) {
    setTab(next);
    const url = new URL(window.location.href); url.searchParams.set('aba', next); window.history.replaceState(null, '', url);
  }
  async function signOut() {
    setLeaving(true); setError('');
    const result = await request<null>('/api/v1/auth/logout', { method: 'POST' });
    setLeaving(false);
    if (result.ok) { setFlash('signed-out'); router.replace('/login'); } else setError(result.message);
  }
  return <Frame eyebrow="EQUIPE / PAINEL">
    <StaffGate view={view} retry={() => void retry()}>
      {({ canWrite }) => <div className="dashboard admin-panel">
        <aside className="dashboard-sidebar">
          <p className="eyebrow">TECH WOMAN / ORGANIZAÇÃO</p><h2>Painel</h2>
          <p className="admin-role">{canWrite ? 'Administração' : 'Equipe · somente leitura'}</p>
          <nav aria-label="Recursos do painel" className="admin-nav">
            {TABS.map(t => <button key={t.key} type="button" className={tab === t.key ? 'side-active' : undefined} aria-current={tab === t.key ? 'page' : undefined} onClick={() => choose(t.key)}>{t.label}</button>)}
            <Link className="sidebar-link" href="/admin/evento">Conteúdo do evento</Link>
          </nav>
          {error && <p role="alert" className="visible-error">{error}</p>}
          <button type="button" className="logout" onClick={() => void signOut()} disabled={leaving}>{leaving ? 'Saindo…' : 'Sair da conta →'}</button>
        </aside>
        <section className="dashboard-main" aria-labelledby="resource-title">
          {!canWrite && <p className="notice admin-readonly" role="note">Acesso de equipe: você pode consultar os cadastros, mas só a administração altera dados.</p>}
          {tab === 'usuarios' && <UsersSection canWrite={canWrite} onAuthError={onAuthError}/>}
          {tab === 'cruzamentos' && <MatchesSection canWrite={canWrite} onAuthError={onAuthError}/>}
          {tab === 'mentoras' && <MentorsSection canWrite={canWrite} onAuthError={onAuthError}/>}
          {tab === 'participantes' && <ParticipantsSection canWrite={canWrite} onAuthError={onAuthError}/>}
        </section>
      </div>}
    </StaffGate>
  </Frame>;
}
