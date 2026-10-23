// Elevação offline de contas (WP-002 Task 3). RED: stub sem comportamento.
export type PrivilegedResult = { code: string };
export async function runPrivilegedAccount(_argv: string[], _env: Record<string, string | undefined>, _options: { afterLock?: () => Promise<void> } = {}): Promise<PrivilegedResult> {
  return { code: 'NOT_IMPLEMENTED' };
}
if (process.argv[1]?.endsWith('privileged-account.ts')) {
  runPrivilegedAccount(process.argv.slice(2), process.env).then(result => { console.log(result.code); process.exitCode = 1; });
}
