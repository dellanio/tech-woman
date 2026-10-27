import type { Metadata } from 'next';
import { preload } from 'react-dom';
import { LoginView } from '../account-ui';
export const metadata: Metadata = { title: 'Entrar | Tech Woman em Recife, PE', robots: { index: false } };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
/** `next` é validado no cliente por safeNext (só caminho local permitido). */
export default async function LoginPage({ searchParams }: Props) {
  // Descoberta no HTML: evita aguardar a cadeia CSS global → @import tipográfico.
  // Reutiliza os mesmos bytes/cache/fontes, sem preload de TTFs desnecessários.
  preload('/fonts/fonts-original.css', { as: 'style' });
  const { next } = await searchParams;
  return <LoginView next={typeof next === 'string' ? next : undefined}/>;
}
