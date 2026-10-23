// Worker de e-mail separado da web. Credencial própria (MAILER_DATABASE_URL); nunca herda DATABASE_URL, MIGRATION_DATABASE_URL nem SESSION_SECRET.
// Uso: tsx scripts/email-worker.ts --once   (sem --once: laço contínuo até SIGINT/SIGTERM). Imprime apenas contagens.
const mailerUrl = process.env.MAILER_DATABASE_URL;
for (const name of ['DATABASE_URL', 'MIGRATION_DATABASE_URL', 'SESSION_SECRET']) delete process.env[name];

const args = process.argv.slice(2);
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function main(): Promise<number> {
  if (!mailerUrl || args.some(arg => arg !== '--once')) { console.error('Uso: MAILER_DATABASE_URL=... tsx scripts/email-worker.ts [--once]'); return 2; }
  process.env.MAILER_DATABASE_URL = mailerUrl;
  const { runEmailWorkerOnce, createDiscardTransport, createSesTransport, closeEmailPool } = await import('../src/lib/email');
  // Fake (descarta segredo) por padrão; SES só com EMAIL_MODE=ses + flags estritas + allowlist do operador.
  const transport = process.env.EMAIL_MODE === 'ses' ? createSesTransport() : createDiscardTransport();
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { stopping = true; });
  try {
    do {
      const result = await runEmailWorkerOnce(transport);
      if (args.includes('--once') || result.claimed > 0) console.log(JSON.stringify({ transport: transport.name, ...result }));
      if (!args.includes('--once') && !stopping) await sleep(5000);
    } while (!args.includes('--once') && !stopping);
    return 0;
  } finally { await closeEmailPool(); }
}
main().then(code => { process.exitCode = code; }, () => { console.error('Falha no worker de e-mail.'); process.exitCode = 1; });
