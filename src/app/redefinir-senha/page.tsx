import type { Metadata } from 'next';
import { ResetView } from '../account-ui';
/** Sem Referer: a URL pode chegar com ?token= antes de o cliente limpá-la. O servidor não lê nem renderiza o token. */
export const metadata: Metadata = { title: 'Redefinir senha | Tech Woman em Recife, PE', robots: { index: false }, referrer: 'no-referrer' };
export default function ResetPage() {
  return <ResetView/>;
}
