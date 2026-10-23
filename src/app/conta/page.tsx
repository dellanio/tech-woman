import type { Metadata } from 'next';
import { AccountHome } from './account-home';
export const metadata: Metadata = { title: 'Sua conta | Tech Woman em Recife, PE', robots: { index: false } };
export const dynamic = 'force-dynamic';
/** Só o ambiente de simulação conhecido (EMAIL_MODE=fake) recebe o aviso NÃO ENVIADA; fora dele, a fila nunca é tratada como entrega. */
export default function AccountPage() {
  return <AccountHome simulated={process.env.EMAIL_MODE === 'fake'}/>;
}
