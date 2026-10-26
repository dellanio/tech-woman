/** Processo isolado: um erro idle não tratado deve falhar a regressão, não matar o runner. */
import { runEmailWorkerOnce, createDiscardTransport, closeEmailPool } from '../../src/lib/email';

async function main() {
  await runEmailWorkerOnce(createDiscardTransport());
  process.send?.({ ready: true, pid: process.pid });
  process.once('message', async () => {
    try {
      const result = await runEmailWorkerOnce(createDiscardTransport());
      process.send?.({ recovered: true, claimed: result.claimed, pid: process.pid });
      await closeEmailPool();
      process.disconnect?.();
    } catch (error) {
      console.error(error instanceof Error ? error.name : 'worker failed');
      process.exitCode = 1;
      await closeEmailPool();
      process.disconnect?.();
    }
  });
}
main().catch(() => { process.exitCode = 1; process.disconnect?.(); });
