import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export const participants = sqliteTable('participant', { id: integer('id').primaryKey({ autoIncrement: true }), email: text('email').notNull(), goal: text('goal').notNull(), moment: text('moment').notNull(), interests: text('interests').notNull(), skills: text('skills').notNull(), area: text('area'), tokenHash: text('token_hash').notNull(), consentVersion: text('consent_version').notNull(), consentAt: text('consent_at').notNull() });
export const mentors = sqliteTable('mentor', { id: integer('id').primaryKey({ autoIncrement: true }), email: text('email').notNull(), trajectory: text('trajectory').notNull(), specialties: text('specialties').notNull(), availability: text('availability').notNull(), capacity: integer('capacity').notNull(), active: integer('active').notNull(), demo: integer('demo').notNull().default(0), demoName: text('demo_name') });
export type Participant = typeof participants.$inferSelect;
export type Mentor = typeof mentors.$inferSelect;
const location = resolve(process.env.DATABASE_PATH || './data/tech-woman.db');
mkdirSync(dirname(location), { recursive: true });
export const sqlite = new Database(process.env.BUILDING === '1' ? ':memory:' : location);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.exec(`CREATE TABLE IF NOT EXISTS participant (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, goal TEXT NOT NULL, moment TEXT NOT NULL, interests TEXT NOT NULL, skills TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, consent_version TEXT NOT NULL, consent_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mentor (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, trajectory TEXT NOT NULL, specialties TEXT NOT NULL, availability TEXT NOT NULL, capacity INTEGER NOT NULL CHECK(capacity>0), active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS match (id INTEGER PRIMARY KEY AUTOINCREMENT, participant_id INTEGER NOT NULL REFERENCES participant(id), mentor_id INTEGER NOT NULL REFERENCES mentor(id), score INTEGER NOT NULL, reasons TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('approved','rejected')));
CREATE UNIQUE INDEX IF NOT EXISTS one_approved_match ON match(participant_id) WHERE status='approved';
CREATE TABLE IF NOT EXISTS email_attempt (participant_id INTEGER PRIMARY KEY REFERENCES participant(id), status TEXT NOT NULL, provider_id TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS choice_email_attempt (participant_id INTEGER PRIMARY KEY REFERENCES participant(id), mentor_id INTEGER NOT NULL REFERENCES mentor(id), status TEXT NOT NULL, provider_id TEXT, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS admin_user (email TEXT PRIMARY KEY, password_hash TEXT NOT NULL, role TEXT NOT NULL);`);
const emailColumns = sqlite.pragma('table_info(email_attempt)') as { name: string }[];
const participantColumns = sqlite.pragma('table_info(participant)') as { name: string }[];
const mentorColumns = sqlite.pragma('table_info(mentor)') as { name: string }[];
if (!mentorColumns.some(column => column.name === 'demo')) sqlite.exec('ALTER TABLE mentor ADD COLUMN demo INTEGER NOT NULL DEFAULT 0');
if (!mentorColumns.some(column => column.name === 'demo_name')) sqlite.exec('ALTER TABLE mentor ADD COLUMN demo_name TEXT');
if (!participantColumns.some(column => column.name === 'area')) sqlite.exec('ALTER TABLE participant ADD COLUMN area TEXT');
if (!emailColumns.some(column => column.name === 'provider_id')) sqlite.exec('ALTER TABLE email_attempt ADD COLUMN provider_id TEXT');
if (!emailColumns.some(column => column.name === 'updated_at')) sqlite.exec("ALTER TABLE email_attempt ADD COLUMN updated_at TEXT NOT NULL DEFAULT ''");
sqlite.exec('CREATE TABLE IF NOT EXISTS demo_seed_state (id INTEGER PRIMARY KEY CHECK(id=1))');
if (process.env.DEMO_MENTORS === '1' && process.env.BUILDING !== '1') {
  sqlite.transaction(() => {
    if (sqlite.prepare('SELECT id FROM demo_seed_state WHERE id=1').get()) return;
    const examples = [
      ['Ana Exemplo (fictícia)','ana-dados','dados','Dados e análise de informação em projetos fictícios.'],
      ['Bia Exemplo (fictícia)','bia-codigo','desenvolvimento','Desenvolvimento de software e programação em cenários de demonstração.'],
      ['Clara Exemplo (fictícia)','clara-produto','produto','Produto digital e descoberta de necessidades fictícias.'],
      ['Dani Exemplo (fictícia)','dani-ux','design','UX e design de experiências em projetos de exemplo.'],
      ['Eva Exemplo (fictícia)','eva-seguranca','desenvolvimento','Segurança de aplicações em exemplos de tecnologia.'],
      ['Fabi Exemplo (fictícia)','fabi-cloud','dados','Infraestrutura e cloud para projetos simulados.'],
      ['Gabi Exemplo (fictícia)','gabi-lideranca','produto','Liderança de equipes e produto em cenários fictícios.'],
      ['Helo Exemplo (fictícia)','helo-carreira','design','Carreira em tecnologia e transição profissional em simulações.']
    ] as const;
    const insert=sqlite.prepare('INSERT INTO mentor(email,trajectory,specialties,availability,capacity,active,demo,demo_name) VALUES(?,?,?,?,3,1,1,?)');
    for (const [name,mail,tag,trajectory] of examples) insert.run(`${mail}@exemplo.invalid`,trajectory,JSON.stringify([tag]),'Disponibilidade ilustrativa, sem horário definido.',name);
    sqlite.prepare('INSERT INTO demo_seed_state(id) VALUES(1)').run();
  }).immediate();
}
export const db = drizzle(sqlite);
export const tokenDigest = (token: string) => createHash('sha256').update(token).digest('hex');
export const newToken = () => randomBytes(32).toString('hex');
export const hashPassword = (password: string) => { const salt = randomBytes(16).toString('hex'); return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`; };
export const verifyPassword = (password: string, stored: string) => { const [salt, digest] = stored.split(':'); if (!/^[a-f0-9]{32}$/.test(salt || '') || !/^[a-f0-9]{128}$/.test(digest || '')) return false; return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(digest, 'hex')); };
if (process.env.LOCAL_SEED === '1') {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  if (!email || !password || password.length < 16 || password.startsWith('replace-')) throw new Error('Configure ADMIN_EMAIL e ADMIN_PASSWORD exclusivos em .env local');
  sqlite.prepare('INSERT OR IGNORE INTO admin_user(email,password_hash,role) VALUES(?,?,?)').run(email, hashPassword(password), 'owner');
}
