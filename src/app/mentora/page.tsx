import type { Metadata } from 'next';
import { MentorSignup } from './signup';
export const metadata: Metadata = { title: 'Para mentoras | Tech Woman em Recife, PE' };
export const dynamic = 'force-dynamic';
/** Sem SES configurado o worker só simula: a confirmação diz NÃO ENVIADA em vez de sugerir entrega. */
export default function MentorPage() {
  return <MentorSignup simulated={process.env.EMAIL_MODE !== 'ses'}/>;
}
