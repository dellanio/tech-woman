import type { Metadata } from 'next';
import { PasswordChangeView } from '../account-ui';
export const metadata: Metadata = { title: 'Definir senha | Tech Woman em Recife, PE', robots: { index: false } };
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
export default async function PasswordChangePage({ searchParams }: Props) {
  const { next } = await searchParams;
  return <PasswordChangeView next={typeof next === 'string' ? next : undefined}/>;
}
