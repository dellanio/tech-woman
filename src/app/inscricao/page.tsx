import type { Metadata } from 'next';
import { ParticipantSignup } from './signup';
export const metadata: Metadata = { title: 'Inscrição | Tech Woman em Recife, PE' };
export const dynamic = 'force-dynamic';
/** Diagnóstico → crossing → e-mail e senha definitiva. O cadastro público não envia e-mail (sem senha temporária). */
export default function RegisterPage() {
  return <ParticipantSignup/>;
}
