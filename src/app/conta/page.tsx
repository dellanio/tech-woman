import type { Metadata } from 'next';
import { AccountHome } from './account-home';
export const metadata: Metadata = { title: 'Sua conta | Tech Woman em Recife, PE', robots: { index: false } };
export const dynamic = 'force-dynamic';
export default function AccountPage() {
  return <AccountHome/>;
}
