import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { getDb, emailAttempts, choiceEmailAttempts, hashPassword, tokenDigest } from './db';
import { generateResetToken, generateTemporaryPassword } from './identity';
import { eq } from 'drizzle-orm';

export type EmailStatus = 'mock-not-sent' | 'unavailable-not-sent' | 'pending' | 'ses-accepted' | 'ses-unconfirmed';
const labels: Record<EmailStatus, string> = {
  'mock-not-sent': 'NÃO ENVIADA — simulação local, nenhum e-mail enviado',
  'unavailable-not-sent': 'NÃO ENVIADA — envio indisponível; inscrição registrada',
  pending: 'CONFIRMAÇÃO PENDENTE — ainda não há aceite do SES',
  'ses-accepted': 'ACEITA PELO SES — entrega ao destinatário não confirmada',
  'ses-unconfirmed': 'ACEITE NÃO CONFIRMADO — o envio pode ter ocorrido; consulte a operação',
};
export function emailLabel(status: string): string {
  return status in labels ? labels[status as EmailStatus] : labels['unavailable-not-sent'];
}
/** Flags estritas do SES (as mesmas de antes); só o transporte do worker pode usá-las para enviar. */
export function sesReady(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.EMAIL_MODE === 'ses' && env.SES_SEND_ENABLED === '1' &&
    env.SES_IDENTITY_VERIFIED === '1' && env.SES_IAM_AUTHORIZED === '1' &&
    env.SES_ACCOUNT_PRODUCTION === '1' && env.SES_REGION === 'us-east-1' &&
    env.SES_FROM === 'no-reply@dellanio.com' && env.LOCAL_SEED !== '1' &&
    env.BUILDING !== '1';
}
/** Exports históricos (cadastro/escolha legados): registram o estado e devolvem o rótulo, mas NUNCA enviam; o envio real só existe no worker. */
const historicalStatus = (): EmailStatus => process.env.EMAIL_MODE === 'ses' ? 'unavailable-not-sent' : 'mock-not-sent';
export async function confirmChoice(participantId:string, mentorId:string, _email:string, _protocol:string, _mentorEmail:string):Promise<string> {
  const status = historicalStatus();
  const entry={participantId:BigInt(participantId),mentorId:BigInt(mentorId),status,providerId:null,updatedAt:new Date().toISOString()};
  await getDb().insert(choiceEmailAttempts).values(entry).onConflictDoUpdate({target:choiceEmailAttempts.participantId,set:entry});
  return emailLabel(status);
}
export async function confirmRegistration(participantId: string, _email: string, _protocol: string): Promise<string> {
  const status = historicalStatus();
  await getDb().update(emailAttempts).set({status,providerId:null,updatedAt:new Date().toISOString()}).where(eq(emailAttempts.participantId,BigInt(participantId)));
  return emailLabel(status);
}

// ---- Worker de e-mail (WP-002 Task 2, R4) ----
export type EmailKind = 'registration' | 'temporary_password' | 'password_reset';
/** `secret` só existe aqui, em memória: nunca em banco, outbox, log ou auditoria. */
export type EmailMessage = { jobId: string; kind: EmailKind; to: string; subject: string; text: string; secret: string };
export type TransportResult = { status: 'accepted' | 'simulated'; providerId?: string };
export interface EmailTransport { readonly name: string; send(message: EmailMessage, signal: AbortSignal): Promise<TransportResult> }
export type EmailWorkerResult = { claimed: number; accepted: number; simulated: number; unconfirmed: number; failed: number; cancelled: number; stale: number };
export type TransportErrorCode = 'TRANSPORT_TIMEOUT' | 'TRANSPORT_ERROR' | 'TRANSPORT_REJECTED' | 'RECIPIENT_NOT_ALLOWED' | 'TRANSPORT_DISABLED';
export class TransportError extends Error { constructor(public code: TransportErrorCode) { super(code); } }
const DEFINITIVE: readonly TransportErrorCode[] = ['TRANSPORT_REJECTED', 'RECIPIENT_NOT_ALLOWED', 'TRANSPORT_DISABLED'];
/** Timeout de envio < lease de 60s do banco. */
export const SEND_TIMEOUT_MS = 30_000;
const MAX_JOBS_PER_RUN = 100;

/** Fake de teste: o segredo só chega ao callback fornecido por quem constrói o transporte. Resultado sempre `simulated` (NÃO ENVIADA). */
export const createMemoryTransport = (onMessage?: (message: EmailMessage) => void | Promise<void>): EmailTransport => ({ name: 'memory', async send(message) { await onMessage?.(message); return { status: 'simulated' }; } });
/** Padrão do worker local/CI: descarta mensagem e segredo. */
export const createDiscardTransport = (): EmailTransport => ({ name: 'discard', async send() { return { status: 'simulated' }; } });

export function emailJobLabel(status: string): string {
  switch (status) {
    case 'accepted': return labels['ses-accepted'];
    case 'simulated': return labels['mock-not-sent'];
    case 'unconfirmed': return labels['ses-unconfirmed'];
    case 'queued': case 'sending': return labels.pending;
    default: return labels['unavailable-not-sent'];
  }
}

let pool: Pool | undefined;
/** Conexão própria do worker (MAILER_DATABASE_URL); o fallback DATABASE_URL existe só para testes em processo. */
function mailerPool(): Pool {
  if (!pool) {
    const connectionString = process.env.MAILER_DATABASE_URL ?? process.env.DATABASE_URL;
    if (!connectionString) throw new Error('Configure MAILER_DATABASE_URL.');
    pool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 3000, statement_timeout: 15000, lock_timeout: 5000, idle_in_transaction_session_timeout: 15000 });
  }
  return pool;
}
export async function closeEmailPool(): Promise<void> { const current = pool; pool = undefined; if (current) await current.end(); }

const compose = (kind: EmailKind, secret: string): { subject: string; text: string } => kind === 'password_reset'
  ? { subject: 'Redefinição de senha | Tech Woman', text: `Seu código de redefinição de senha (válido por 30 minutos, uso único): ${secret}\nSe recebeu mais de um e-mail de acesso, use apenas o acesso mais recente.` }
  : { subject: 'Seu acesso | Tech Woman', text: `Sua senha temporária (válida por 24 horas) é: ${secret}\nEntre com ela e defina sua senha definitiva.\nSe recebeu mais de um e-mail de acesso, use apenas o acesso mais recente.` };

async function sendBounded(transport: EmailTransport, message: EmailMessage): Promise<TransportResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const attempt = transport.send(message, controller.signal);
    attempt.catch(() => undefined);
    return await Promise.race([attempt, new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new TransportError('TRANSPORT_TIMEOUT'))))]);
  } finally { clearTimeout(timer); }
}
const classify = (error: unknown): { status: 'unconfirmed' | 'failed'; code: TransportErrorCode } => {
  const code: TransportErrorCode = error instanceof TransportError ? error.code : 'TRANSPORT_ERROR';
  return { status: DEFINITIVE.includes(code) ? 'failed' : 'unconfirmed', code };
};

/** Processa jobs vencidos: claim → segredo em memória → emissão sob lock (commit) → transporte fora da transação → finalização condicional. Retorna só contagens. */
export async function runEmailWorkerOnce(transport: EmailTransport, workerId: string = randomUUID()): Promise<EmailWorkerResult> {
  const result: EmailWorkerResult = { claimed: 0, accepted: 0, simulated: 0, unconfirmed: 0, failed: 0, cancelled: 0, stale: 0 };
  const db = mailerPool();
  for (let i = 0; i < MAX_JOBS_PER_RUN; i++) {
    const claim = (await db.query('select * from internal.email_claim($1::uuid)', [workerId])).rows[0];
    if (!claim) break;
    result.claimed++;
    const kind = claim.kind as EmailKind;
    const secret = kind === 'password_reset' ? generateResetToken() : generateTemporaryPassword();
    const hash = kind === 'password_reset' ? tokenDigest(secret) : await hashPassword(secret);
    const begin = (await db.query('select * from internal.email_emit_begin($1::uuid,$2::uuid,$3)', [claim.job_id, workerId, hash])).rows[0];
    if (begin?.outcome === 'cancelled') { result.cancelled++; continue; }
    if (begin?.outcome !== 'issued') { result.stale++; continue; }
    let status: 'accepted' | 'simulated' | 'unconfirmed' | 'failed', providerId: string | null = null, code: string | null = null;
    try {
      const sent = await sendBounded(transport, { jobId: String(claim.job_id), kind, to: String(begin.destination), ...compose(kind, secret), secret });
      status = sent.status; providerId = sent.providerId ?? null;
    } catch (error) { ({ status, code } = classify(error)); }
    const done = (await db.query('select internal.email_emit_finish($1::uuid,$2::uuid,$3::uuid,$4,$5,$6) as r', [claim.job_id, workerId, begin.attempt_id, status, providerId, code])).rows[0];
    if (done?.r === 'applied') result[status]++; else if (done?.r === 'failed') result.failed++; else result.stale++;
  }
  return result;
}

// ---- Transporte SES restrito (operador) ----
export const SES_ALLOWLIST_ENV = 'SES_RECIPIENT_ALLOWLIST';
const LEASE_MS = 60_000;
export type SesLikeClient = { send(command: SendEmailCommand, options?: { abortSignal?: AbortSignal }): Promise<{ MessageId?: string }> };
/** Uma tentativa por chamada (maxAttempts 1): reenvio é decisão do worker, sob lock. */
export const createSesClient = (): SesLikeClient => new SESClient({ region: 'us-east-1', maxAttempts: 1 }) as unknown as SesLikeClient;
const allowedRecipients = (env: NodeJS.ProcessEnv) => new Set((env[SES_ALLOWLIST_ENV] ?? '').split(',').map(v => v.trim().toLowerCase()).filter(Boolean));
const REJECTED_NAMES = ['MessageRejected', 'MailFromDomainNotVerifiedException', 'ConfigurationSetDoesNotExistException', 'AccountSendingPausedException'];
const toTransportError = (error: unknown): TransportError => {
  if (error instanceof TransportError) return error;
  const name = error instanceof Error ? error.name : '';
  if (name === 'AbortError' || name === 'TimeoutError') return new TransportError('TRANSPORT_TIMEOUT');
  return new TransportError(REJECTED_NAMES.includes(name) ? 'TRANSPORT_REJECTED' : 'TRANSPORT_ERROR');
};
/**
 * Só envia com as flags estritas E destinatário na allowlist aprovada pelo operador (SES_RECIPIENT_ALLOWLIST).
 * Erros viram TransportError com código fixo: a mensagem do SDK nunca sai daqui. `accepted` não significa entregue.
 */
export function createSesTransport(options: { client?: SesLikeClient; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): EmailTransport {
  const env = options.env ?? process.env, timeoutMs = options.timeoutMs ?? 20_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs >= LEASE_MS) throw new Error('O timeout do SES deve ser positivo e menor que o lease de 60s.');
  let client = options.client;
  return {
    name: 'ses',
    async send(message, signal) {
      if (!sesReady(env)) throw new TransportError('TRANSPORT_DISABLED');
      if (!allowedRecipients(env).has(message.to.trim().toLowerCase())) throw new TransportError('RECIPIENT_NOT_ALLOWED');
      client ??= createSesClient();
      try {
        const result = await client.send(new SendEmailCommand({
          Source: `Tech Woman <${env.SES_FROM}>`, Destination: { ToAddresses: [message.to] },
          Message: { Subject: { Data: message.subject, Charset: 'UTF-8' }, Body: { Text: { Data: message.text, Charset: 'UTF-8' } } },
        }), { abortSignal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
        if (!result.MessageId) throw new TransportError('TRANSPORT_ERROR');
        return { status: 'accepted', providerId: result.MessageId };
      } catch (error) { throw toTransportError(error); }
    },
  };
}
