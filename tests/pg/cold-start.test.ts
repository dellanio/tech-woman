/** FIX-T01: real PG behind a TCP proxy; only the handshake is delayed, never SQL responses. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, connect, type Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { withDb, addUser, sessionFor, roleUrl } from './identity-harness.test';
import { GET } from '../../src/app/api/v1/auth/session/route';
import { closeDb } from '../../src/lib/db';
import { closeEmailPool, runEmailWorkerOnce, createMemoryTransport } from '../../src/lib/email';

/** null accepts TCP but never forwards a byte (unavailable handshake). No PostgreSQL mocks. */
async function proxy(target: string, delayMs: number | null) {
  const destination = new URL(target);
  const upstreamHost = destination.hostname;
  const upstreamPort = Number(destination.port || 5432);
  const sockets = new Set<Socket>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let accepted = 0;
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.on('error', () => socket.destroy());
    socket.once('close', () => sockets.delete(socket));
    return socket;
  };
  const server = createServer(client => {
    accepted++;
    track(client);
    client.pause();
    if (delayMs === null) return;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (client.destroyed) return;
      const upstream = track(connect({ host: upstreamHost, port: upstreamPort }));
      client.once('close', () => upstream.destroy());
      upstream.once('close', () => client.destroy());
      upstream.once('connect', () => { client.pipe(upstream); upstream.pipe(client); client.resume(); });
    }, delayMs);
    timers.add(timer);
    client.once('close', () => { clearTimeout(timer); timers.delete(timer); });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  destination.hostname = '127.0.0.1';
  destination.port = String(address.port);
  // TCP forwarding cannot use the caller's Unix socket override.
  destination.searchParams.delete('host');
  return {
    url: destination.toString(),
    accepted: () => accepted,
    async close() {
      for (const timer of timers) clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

test('FIX-T01: first authenticated request on a cold pool survives a 3500 ms PG handshake, including pool restart', { timeout: 40000 }, async () => {
  await withDb(async ({ db, runtimeUrl }) => {
    const user = await addUser(db);
    const token = await sessionFor(db, user.id);
    const slow = await proxy(runtimeUrl, 3500);
    try {
      process.env.DATABASE_URL = slow.url;
      for (const phase of ['start', 'restart']) {
        await closeDb(); // no warmup: the session handler must open the first connection itself
        const started = performance.now();
        const response = await GET(new Request(`${process.env.APP_ORIGIN}/api/v1/auth/session`, {
          headers: { Cookie: `tw_session=${token}` },
        }));
        const payload: { data?: { state?: string; user?: { id?: string } } } = await response.json();
        assert.equal(response.status, 200, `${phase}: first request must not return a connect-timeout 5xx`);
        assert.equal(payload.data?.state, 'authenticated');
        assert.equal(payload.data?.user?.id, user.id);
        assert.ok(performance.now() - started >= 3500, 'real delayed handshake was exercised');
      }
      assert.equal(slow.accepted(), 2, 'one connection per cold pool; no query replay');
    } finally { await closeDb(); await slow.close(); }
  });
});

test('FIX-T01: cold mailer connection tolerates a 3500 ms PG handshake without sending mail', { timeout: 25000 }, async () => {
  await withDb(async ({ url }) => {
    const slow = await proxy(roleUrl(url, 'techwoman_mailer'), 3500);
    try {
      process.env.MAILER_DATABASE_URL = slow.url;
      const started = performance.now();
      const result = await runEmailWorkerOnce(createMemoryTransport(() => assert.fail('empty queue must not send')));
      assert.equal(result.claimed, 0);
      assert.ok(performance.now() - started >= 3500);
      assert.equal(slow.accepted(), 1);
    } finally { await closeEmailPool(); await slow.close(); }
  });
});

test('FIX-T01: unavailable web and mailer handshakes fail within the finite 10 s acquisition budget', { timeout: 40000 }, async () => {
  await withDb(async ({ db, runtimeUrl, url }) => {
    const user = await addUser(db);
    const token = await sessionFor(db, user.id);
    const unavailable = await proxy(runtimeUrl, null);
    try {
      process.env.DATABASE_URL = unavailable.url;
      const started = performance.now();
      const response = await GET(new Request(`${process.env.APP_ORIGIN}/api/v1/auth/session`, {
        headers: { Cookie: `tw_session=${token}` },
      }));
      assert.equal(response.status, 503);
      const payload: { error?: { code?: string } } = await response.json();
      assert.equal(payload.error?.code, 'DEPENDENCY_UNAVAILABLE');
      const elapsed = performance.now() - started;
      assert.ok(elapsed >= 9000 && elapsed < 12000, `web acquisition elapsed ${elapsed} ms`);
      console.log(`web unavailable handshake: ${Math.round(elapsed)} ms, HTTP ${response.status}`);
      await closeDb();
      const mailerUrl = new URL(roleUrl(url, 'techwoman_mailer'));
      mailerUrl.port = new URL(unavailable.url).port;
      mailerUrl.searchParams.delete('host');
      process.env.MAILER_DATABASE_URL = mailerUrl.toString();
      const mailerStarted = performance.now();
      await assert.rejects(runEmailWorkerOnce(createMemoryTransport(() => assert.fail('unavailable DB must not send'))), /timeout|terminated/i);
      const mailerElapsed = performance.now() - mailerStarted;
      assert.ok(mailerElapsed >= 9000 && mailerElapsed < 12000, `mailer acquisition elapsed ${mailerElapsed} ms`);
      console.log(`mailer unavailable handshake: ${Math.round(mailerElapsed)} ms, rejected`);
      assert.equal(unavailable.accepted(), 2, 'no retries or extra connections');
    } finally { await closeDb(); await closeEmailPool(); await unavailable.close(); }
  });
});

