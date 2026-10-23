/**
 * S11 — finite lock/statement/idle-in-transaction limits for techwoman_runtime/mailer/beatriz, set by the operator
 * artifact ops/sql/role-limits.sql with scope IN DATABASE (never a global ALTER ROLE that would reach neighbours).
 * Real PostgreSQL 16 in the ops tests' OWN disposable cluster (tests/ops/pg/cluster.py): login settings only apply to
 * NEW LOGIN connections, so the roles get LOGIN there (disposable cluster only) and every check opens a real login
 * connection — SET ROLE would not apply them and is shown not to. Product schema/functions come from the real
 * migrations through the existing harness (read-only import). No sleep-based ordering: pg_stat_activity barriers.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {randomUUID, createHash} from 'node:crypto';
import {Client, Pool} from 'pg';

// The harness reads MIGRATION_DATABASE_URL at import time: point it at the disposable cluster first.
process.env.MIGRATION_DATABASE_URL = execFileSync(process.env.PYTHON ?? 'python3', ['tests/ops/pg/cluster.py', 'ensure'], {encoding: 'utf8'}).trim();
const harness = () => import('../../pg/agenda-harness');
const kit = () => import('../../pg/agenda-api-kit');
const db_ = () => import('../../../src/lib/db');

const ROLES = ['techwoman_runtime', 'techwoman_mailer', 'techwoman_beatriz'];
const loginUrl = (url: string, role: string) => {const u = new URL(url); u.username = role; return u.toString();};
const dbName = (url: string) => new URL(url).pathname.slice(1);

function applyLimits(url: string, vars: Record<string, string> = {}) {
  const args = ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', url, '-f', 'ops/sql/role-limits.sql'];
  for (const [k, v] of Object.entries(vars)) args.push('-v', `${k}=${v}`);
  return spawnSync('psql', args, {encoding: 'utf8'});
}
async function settings(db: Pool) {
  return (await db.query(`select r.rolname role, d.datname db, s.setconfig cfg from pg_db_role_setting s
    join pg_roles r on r.oid=s.setrole left join pg_database d on d.oid=s.setdatabase where r.rolname = any($1) order by 1`, [ROLES])).rows;
}
async function login<T>(url: string, role: string, fn: (c: Client) => Promise<T>) {
  const c = new Client({connectionString: loginUrl(url, role)}); await c.connect();
  try {return await fn(c);} finally {await c.end().catch(() => undefined);}
}
async function show(c: Client) {
  const out: Record<string, string> = {};
  for (const k of ['lock_timeout', 'statement_timeout', 'idle_in_transaction_session_timeout']) out[k] = (await c.query(`show ${k}`)).rows[0][k];
  return out;
}
/** Disposable cluster only: the product roles need LOGIN for login-time settings to be observable. */
async function canLogin(db: Pool) {for (const r of ROLES) await db.query(`alter role ${r} login`);}

test('role-limits.sql stores finite timeouts per role IN DATABASE, idempotently, and refuses invalid or hostile values', async () => {
  const {withDb} = await harness();
  await withDb(async ({db, url}) => {
    const first = applyLimits(url);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(applyLimits(url).status, 0, 'idempotent');
    const rows = await settings(db);
    assert.deepEqual(rows.map(r => [r.role, r.db]), ROLES.slice().sort().map(r => [r, dbName(url)]), 'one row per role, scoped to this database only');
    const byRole = Object.fromEntries(rows.map(r => [r.role, [...r.cfg].sort()]));
    assert.deepEqual(byRole.techwoman_runtime, ['idle_in_transaction_session_timeout=10s', 'lock_timeout=5s', 'statement_timeout=15s']);
    assert.deepEqual(byRole.techwoman_mailer, ['idle_in_transaction_session_timeout=10s', 'lock_timeout=5s', 'statement_timeout=15s']);
    assert.deepEqual(byRole.techwoman_beatriz, ['idle_in_transaction_session_timeout=30s', 'lock_timeout=10s', 'statement_timeout=60s']);
    for (const bad of [{runtime_lock: '0'}, {beatriz_idle: '-1s'}, {mailer_statement: 'forever'}, {runtime_lock: "5s'; drop role techwoman_mailer; --"}]) {
      const r = applyLimits(url, bad);
      assert.notEqual(r.status, 0, JSON.stringify(bad));
      assert.deepEqual(await settings(db), rows, 'a refused run changes nothing: ' + JSON.stringify(bad));
    }
    assert.equal((await db.query("select count(*)::int n from pg_roles where rolname='techwoman_mailer'")).rows[0].n, 1);
  });
});

test('the limits are effective in NEW login connections of each role, not through SET ROLE, and not in a neighbour database', async () => {
  const {withDb} = await harness();
  await withDb(async ({db, url}) => {
    await canLogin(db);
    assert.equal(applyLimits(url).status, 0);
    for (const [role, lock, statement, idle] of [['techwoman_runtime', '5s', '15s', '10s'], ['techwoman_mailer', '5s', '15s', '10s'], ['techwoman_beatriz', '10s', '1min', '30s']]) {
      assert.deepEqual(await login(url, role, show), {lock_timeout: lock, statement_timeout: statement, idle_in_transaction_session_timeout: idle}, role);
    }
    const viaSetRole = new Client({connectionString: url}); await viaSetRole.connect();
    try {await viaSetRole.query('set role techwoman_runtime'); assert.equal((await show(viaSetRole)).lock_timeout, '0', 'SET ROLE does not apply login settings');}
    finally {await viaSetRole.end();}
    const neighbour = 'tw_neighbour_' + randomUUID().replace(/-/g, '').slice(0, 12);
    await db.query(`create database ${neighbour}`);
    try {
      const u = new URL(url); u.pathname = '/' + neighbour;
      assert.deepEqual(await login(u.toString(), 'techwoman_runtime', show), {lock_timeout: '0', statement_timeout: '0', idle_in_transaction_session_timeout: '0'});
    } finally {await db.query(`drop database ${neighbour} with (force)`);}
  });
});

test('statement and lock limits end the wait with 57014/55P03 instead of blocking forever', async () => {
  const {withDb} = await harness();
  await withDb(async ({db, url}) => {
    await canLogin(db);
    assert.equal(applyLimits(url, {runtime_statement: '2s', runtime_lock: '1s'}).status, 0);
    await login(url, 'techwoman_runtime', async runtime => {
      const started = Date.now();
      await assert.rejects(runtime.query('select pg_sleep(30)'), (e: {code?: string}) => e.code === '57014');
      assert.ok(Date.now() - started < 2000 + 3000, 'statement_timeout ended the query');
    });
    await login(url, 'techwoman_beatriz', async editor => login(url, 'techwoman_runtime', async runtime => {
      await editor.query('select pg_advisory_lock(741005)');
      const started = Date.now();
      await assert.rejects(runtime.query('select pg_advisory_lock(741005)'), (e: {code?: string}) => e.code === '55P03');
      assert.ok(Date.now() - started < 1000 + 3000, 'lock_timeout ended the wait');
    }));
  });
});

test('an idle editor transaction holding the agenda guard is terminated and five independent reservations go through', async () => {
  const {withDb, mentorWithCohort, pidOf, waitLocked} = await harness();
  const {participantActor} = await kit();
  const {tokenDigest} = await db_();
  await withDb(async ({db, url}) => {
    await canLogin(db);
    assert.equal(applyLimits(url, {beatriz_idle: '2s'}).status, 0);
    const agenda = await mentorWithCohort(db, {capacity: 5, from: 20});
    const people = await Promise.all([1, 2, 3, 4, 5].map(() => participantActor(db)));
    const editor = new Client({connectionString: loginUrl(url, 'techwoman_beatriz')}); await editor.connect();
    let editorError: {code?: string} | undefined;
    editor.on('error', e => {editorError = e as {code?: string};});
    const editorPid = await pidOf(editor);
    await editor.query('begin');
    await editor.query("update topic set name = 'Tema editado' where id = (select topic_id from mentor_topic limit 1)");  // takes the guard
    const runtime = new Pool({connectionString: loginUrl(url, 'techwoman_runtime'), max: 5});
    try {
      const started = Date.now();
      const reservations = people.map(p => runtime.query('select internal.api_enroll($1,$2,$3,$4,$5) r',
        [tokenDigest(p.token), randomUUID(), randomUUID(), createHash('sha256').update(p.id).digest('hex'), {cohortId: agenda.cohort}]));
      reservations.forEach(r => r.catch(() => undefined));
      // barrier: the reservations are really waiting on a lock (the guard held by the idle editor)
      let blocked: {pid: number}[] = [];
      for (let i = 0; i < 60 && !blocked.length; i++) {
        blocked = (await db.query("select pid from pg_stat_activity where usename='techwoman_runtime' and datname=current_database() and wait_event_type='Lock'")).rows;
        if (!blocked.length) await new Promise(r => setTimeout(r, 25));
      }
      assert.ok(blocked.length >= 1, 'a reservation was blocked behind the idle editor');
      await waitLocked(db, blocked[0].pid);
      const results = await Promise.all(reservations);
      const waited = Date.now() - started;
      assert.deepEqual(results.map(r => r.rows[0].r.status), ['active', 'active', 'active', 'active', 'active']);
      assert.ok(waited >= 1000 && waited < 2000 + 3000, `released by the 2s idle limit (${waited} ms)`);
      assert.equal((await db.query('select count(*)::int n from pg_stat_activity where pid=$1', [editorPid])).rows[0].n, 0, 'the idle editor session was terminated');
      assert.equal((await runtime.query('select 1 one')).rows[0].one, 1, 'the runtime pool is not exhausted');
      const counts = (await db.query(`select (select count(*)::int from enrollment where cohort_id=$1 and status='active') e,
        (select count(*)::int from match m join enrollment x on x.id=m.enrollment_id where x.cohort_id=$1) m,
        (select count(*)::int from email_job j join enrollment x on x.id=j.enrollment_id where x.cohort_id=$1) j`, [agenda.cohort])).rows[0];
      assert.deepEqual(counts, {e: 5, m: 5, j: 5});
      assert.equal((await db.query("select name from topic where id=(select topic_id from mentor_topic limit 1)")).rows[0].name === 'Tema editado', false, 'the editor change was rolled back');
      await assert.rejects(editor.query('select 1'));
      assert.ok(!editorError || ['25P03', '57P01'].includes(String(editorError.code)) || editorError.code === undefined);
    } finally {
      await runtime.end(); await editor.end().catch(() => undefined);
    }
  });
});
