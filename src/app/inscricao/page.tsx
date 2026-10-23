import type { Metadata } from 'next';
import { ParticipantSignup } from './signup';
export const metadata: Metadata = { title: 'Inscrição | Tech Woman em Recife, PE' };
export const dynamic = 'force-dynamic';
/** Sem SES configurado o worker só simula: a confirmação diz NÃO ENVIADA em vez de sugerir entrega. */
export default function RegisterPage() {
  return <ParticipantSignup simulated={process.env.EMAIL_MODE !== 'ses'}/>;
}
