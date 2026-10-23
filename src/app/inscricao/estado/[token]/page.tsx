import type { Metadata } from 'next';
import Link from 'next/link';
import { stateFor } from '@/lib/service';
import { Frame } from '@/app/shared';
export const dynamic = 'force-dynamic';
/** O caminho carrega o token antigo: fora de buscadores e sem Referer para nenhum link desta página. */
export const metadata: Metadata = { title: 'Histórico da inscrição | Tech Woman em Recife, PE', robots: { index: false }, referrer: 'no-referrer' };

/**
 * Link antigo: só leitura do histórico (stateFor, buscado pelo hash do token; projeção sem e-mail de mentora). Não escolhe nem reserva —
 * o POST antigo é recusado — e não inventa turma, data ou horário para o legado. Escolha nova só pela conta ativada.
 */
export default async function StatusPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const state = await stateFor(token);
  if (!state) return <Frame eyebrow="HISTÓRICO ANTERIOR"><section className="state-card">
    <p className="eyebrow">LINK INDISPONÍVEL</p><h1>Não foi possível abrir este histórico.</h1>
    <p className="hero-lead">O endereço pode estar incompleto ou não estar mais disponível. Se você já tem conta, entre por ela para ver suas reservas.</p>
    <div className="auth-actions"><Link className="button-primary" href="/login">Entrar na conta ↗</Link><Link className="button-quiet" href="/">Voltar ao encontro</Link></div>
  </section></Frame>;
  const { mentor } = state;
  return <Frame eyebrow="HISTÓRICO ANTERIOR"><section className="state-card legacy-state">
    <p className="eyebrow">{state.protocol} / HISTÓRICO ANTERIOR</p>
    <h1>Seu histórico <em>continua aqui.</em></h1>
    <p className="hero-lead">Este link mostra o que ficou registrado no cadastro anterior. Ele não faz escolhas nem reservas novas.</p>
    <div className="status-box"><span>ESTADO NO CADASTRO ANTERIOR</span><strong>{mentor ? 'Mentoria registrada' : 'Sem mentoria registrada'}</strong></div>
    {mentor ? <div className="status-box"><span>MENTORA DO CADASTRO ANTERIOR {mentor.demo && <span className="demo-badge">Demonstração</span>}</span><strong>{mentor.displayName}</strong>
      <p className="legacy-flag">Histórico anterior — sem turma/data/hora registrados</p>
      <p>{mentor.trajectory}</p>
      {mentor.reasons.length > 0 && <><p className="field-hint">Motivos registrados na época:</p><ul>{mentor.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul></>}
      <p className="field-hint">Sua decisão anterior foi preservada como histórico.</p>
    </div> : <div className="status-box"><span>MENTORIA</span><p>O cadastro anterior não tem mentora registrada. Nenhuma escolha fica pendente neste link.</p></div>}
    <div className="status-box"><span>PARA ESCOLHER MENTORA, TEMA E TURMA</span>
      <p>Ative sua conta e entre no site. Na sua conta você escolhe mentora, tema e turma, com data e horário de Recife. Para ativar, peça o acesso com o e-mail do cadastro; se já tem senha, é só entrar.</p>
      <div className="auth-actions"><Link className="button-primary" href="/recuperar-senha">Ativar ou recuperar acesso ↗</Link><Link className="button-secondary" href="/login">Entrar na conta</Link></div>
    </div>
    <p className="mock-banner">Confirmação do cadastro anterior: {state.emailStatus}</p>
    {state.choiceEmailStatus && <p className="mock-banner">Confirmação da escolha anterior: {state.choiceEmailStatus}</p>}
    <Link className="text-link" href="/">Voltar ao encontro ↗</Link>
  </section></Frame>;
}
