// Contract between the REAL importer (scripts/migration/import.ts) and the cutover tooling in ops/:
// the report shape that `cutover.py import-verify` accepts, the repeat-import proof of source_checksum, and the
// logical checksum of ops/snapshot.py. Synthetic data only; needs a synthetic PostgreSQL 16 (MIGRATION_DATABASE_URL).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';

const base = process.env.MIGRATION_DATABASE_URL;
const python = process.env.PYTHON ?? 'python3';

const LEGACY = `
CREATE TABLE participant(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,goal TEXT NOT NULL,moment TEXT NOT NULL,interests TEXT NOT NULL,skills TEXT NOT NULL,area TEXT,token_hash TEXT UNIQUE NOT NULL,consent_version TEXT NOT NULL,consent_at TEXT NOT NULL);
CREATE TABLE mentor(id INTEGER PRIMARY KEY AUTOINCREMENT,email TEXT NOT NULL,trajectory TEXT NOT NULL,specialties TEXT NOT NULL,availability TEXT NOT NULL,capacity INTEGER NOT NULL,active INTEGER NOT NULL,demo INTEGER NOT NULL,demo_name TEXT);
CREATE TABLE match(id INTEGER PRIMARY KEY AUTOINCREMENT,participant_id INTEGER REFERENCES participant(id),mentor_id INTEGER REFERENCES mentor(id),score INTEGER,reasons TEXT,status TEXT);
CREATE TABLE admin_user(email TEXT PRIMARY KEY,password_hash TEXT,role TEXT);
CREATE TABLE email_attempt(participant_id INTEGER PRIMARY KEY REFERENCES participant(id),status TEXT,provider_id TEXT,updated_at TEXT);
CREATE TABLE choice_email_attempt(participant_id INTEGER PRIMARY KEY REFERENCES participant(id),mentor_id INTEGER REFERENCES mentor(id),status TEXT,provider_id TEXT,updated_at TEXT);
CREATE TABLE event_content(id INTEGER PRIMARY KEY,description TEXT,venue TEXT,agenda TEXT,speakers TEXT,date TEXT,duration TEXT);
`;

function tail(stdout: string) {
  const lines = stdout.split('\n').filter((line) => line.trim());
  return JSON.parse(lines[lines.length - 1]);
}

test('importer report, repeat-import proof and logical checksum match what ops/cutover.py expects', async () => {
  assert.ok(base, 'MIGRATION_DATABASE_URL must point at a synthetic PostgreSQL 16 (see the WP-005 brief)');
  const name = 'tw_ops_imp_' + randomUUID().replace(/-/g, '');
  const control = new Pool({ connectionString: base });
  await control.query(`CREATE DATABASE ${name}`);
  const url = new URL(base);
  url.pathname = '/' + name;
  const env = { ...process.env, MIGRATION_DATABASE_URL: url.toString() };
  const scratch = mkdtempSync(join(tmpdir(), 'tw-ops-import-'));
  const db = new Pool({ connectionString: url.toString() });
  try {
    execFileSync('node', ['--import', 'tsx', 'scripts/migration/migrate.ts'], { env, stdio: 'pipe' });
    const source = join(scratch, 'source.db');
    execFileSync(python, ['-c', `
import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.executescript(sys.argv[2])
c.execute('INSERT INTO participant VALUES(?,?,?,?,?,?,?,?,?,?)', (1, 'ana@example.invalid', 'growth', 'working', '["dados"]', '["analise"]', 'dados', 'a' * 64, 'v1', '2026-10-01T10:00:00-03:00'))
c.execute('INSERT INTO mentor VALUES(1,?,?,?,?,?,?,?,?)', ('mentora@example.invalid', 'Trajetoria ficticia', '["dados"]', 'texto', 3, 1, 0, None))
c.execute('INSERT INTO match VALUES(1,1,1,9,?,?)', ('["razao"]', 'approved'))
c.execute("INSERT INTO event_content VALUES(1,'Encontro sintetico','Recife, PE','Agenda textual','Texto','2026-11-14','2h')")
c.commit()
c.close()
`, source, LEGACY]);
    const copy = join(scratch, 'copy.db');
    const backup = JSON.parse(execFileSync(python, ['-I', 'ops/snapshot.py', 'backup', source, copy], { encoding: 'utf8' }));
    assert.deepEqual(Object.keys(backup).sort(), ['bytes', 'checksum', 'counts', 'file_sha256']);

    const run = () => tail(execFileSync('node', ['--import', 'tsx', 'scripts/migration/import.ts', copy], { env, encoding: 'utf8' }));
    const first = run();
    const second = run();
    for (const report of [first, second]) {
      assert.deepEqual(Object.keys(report).sort(), ['counts', 'dryRun', 'idempotent', 'issues', 'runId', 'status']);
      assert.equal(report.dryRun, false);
      assert.equal(typeof report.issues, 'number');
    }
    assert.equal(first.idempotent, false);
    assert.equal(second.idempotent, true);
    assert.equal(second.runId, first.runId);

    // the repeat is idempotent exactly because migration_run.source_checksum is the snapshot's logical checksum
    const stored = await db.query('select source_checksum, status from public.migration_run where id = $1', [first.runId]);
    assert.equal(stored.rows[0].source_checksum, backup.checksum);

    const issues = await db.query('select source_table, code from public.migration_issue where run_id = $1 order by 1, 2', [first.runId]);
    assert.deepEqual(issues.rows, [], 'importer issues: ' + JSON.stringify(issues.rows));

    // and a clean import is what cutover.py import-verify accepts; anything else must be refused
    const accepted = execFileSync(python, ['-I', '-c', `
import sys; sys.path.insert(0, 'ops')
import cutover
print(cutover._import_report(sys.argv[1])['runId'])
`, JSON.stringify(first)], { encoding: 'utf8', stdio: 'pipe' }).trim();
    assert.equal(first.status, 'imported', 'the synthetic legacy fixture must import cleanly: ' + JSON.stringify(first));
    assert.equal(first.issues, 0);
    assert.equal(accepted, first.runId);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    await db.end();
    await control.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await control.end();
  }
});
