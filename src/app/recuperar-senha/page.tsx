import type { Metadata } from 'next';
import { ForgotView } from '../account-ui';
export const metadata: Metadata = { title: 'Recuperar senha | Tech Woman em Recife, PE', robots: { index: false } };
export const dynamic = 'force-dynamic';
/** Sem SES configurado o worker só simula: a tela diz NÃO ENVIADA em vez de sugerir entrega. */
export default function ForgotPage() {
  return <ForgotView simulated={process.env.EMAIL_MODE !== 'ses'}/>;
}
