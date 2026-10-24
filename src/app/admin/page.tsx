import type { Metadata } from 'next';
import { AdminPanel } from './components/admin-panel';
export const metadata: Metadata = { title: 'Painel da organização | Tech Woman em Recife, PE', robots: { index: false } };
export const dynamic = 'force-dynamic';
export default function AdminPage() {
  return <AdminPanel/>;
}
