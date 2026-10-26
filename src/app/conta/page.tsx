import type { Metadata } from 'next';
import { preload } from 'react-dom';
import { AccountHome } from './account-home';
export const metadata: Metadata = { title: 'Sua conta | Tech Woman em Recife, PE', robots: { index: false } };
export const dynamic = 'force-dynamic';
/** Só o ambiente de simulação conhecido (EMAIL_MODE=fake) recebe o aviso NÃO ENVIADA; fora dele, a fila nunca é tratada como entrega. */
export default function AccountPage() {
  // Mesma descoberta antecipada usada no login: evita troca tardia de fonte no prólogo compacto.
  preload('/fonts/fonts-original.css', { as: 'style' });
  return <AccountHome simulated={process.env.EMAIL_MODE === 'fake'}/>;
}
