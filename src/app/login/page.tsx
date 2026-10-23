import type { Metadata } from 'next';
import { LoginView } from '../account-ui';
export const metadata: Metadata = { title: 'Entrar | Tech Woman em Recife, PE', robots: { index: false } };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
/** `next` é validado no cliente por safeNext (só caminho local permitido). */
export default async function LoginPage({ searchParams }: Props) {
  const { next } = await searchParams;
  return <LoginView next={typeof next === 'string' ? next : undefined}/>;
}
