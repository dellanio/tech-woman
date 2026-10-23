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
function readyForSes() {
  return process.env.EMAIL_MODE === 'ses' && process.env.SES_SEND_ENABLED === '1' &&
    process.env.SES_IDENTITY_VERIFIED === '1' && process.env.SES_IAM_AUTHORIZED === '1' &&
    process.env.SES_ACCOUNT_PRODUCTION === '1' && process.env.SES_REGION === 'us-east-1' &&
    process.env.SES_FROM === 'no-reply@dellanio.com' && process.env.LOCAL_SEED !== '1' &&
    process.env.BUILDING !== '1';
}
export async function confirmChoice(participantId:string, mentorId:string, email:string, protocol:string, mentorEmail:string):Promise<string> {
  const update = async (pid:string,mid:string,status:string,providerId:string|null,updatedAt:string) => { const entry={participantId:BigInt(pid),mentorId:BigInt(mid),status,providerId,updatedAt};await getDb().insert(choiceEmailAttempts).values(entry).onConflictDoUpdate({target:choiceEmailAttempts.participantId,set:entry}); };
  const status:EmailStatus = !readyForSes() ? (process.env.EMAIL_MODE==='ses'?'unavailable-not-sent':'mock-not-sent') : 'pending';
  await update(participantId,mentorId,status,null,new Date().toISOString());
  if (!readyForSes()) return emailLabel(status);
  try {
    const result=await new SESClient({region:'us-east-1',maxAttempts:1}).send(new SendEmailCommand({
      Source:`Tech Woman <${process.env.SES_FROM}>`, Destination:{ToAddresses:[email]},
      Message:{Subject:{Data:'Sua mentoria escolhida | Tech Woman',Charset:'UTF-8'},Body:{Text:{Data:`Protocolo ${protocol}. Você escolheu a mentora ${mentorEmail} para uma mentoria, sem horário definido. Consulte seu link individual para conferir o estado atualizado.`,Charset:'UTF-8'}}}
    }));
    if (!result.MessageId) throw new Error('Aceite sem identificador');
    await update(participantId,mentorId,'ses-accepted',result.MessageId,new Date().toISOString());
    return emailLabel('ses-accepted');
  } catch {
    await update(participantId,mentorId,'ses-unconfirmed',null,new Date().toISOString());
    return emailLabel('ses-unconfirmed');
  }
}
export async function confirmRegistration(participantId: string, email: string, protocol: string): Promise<string> {
  const update=async(status:string,providerId:string|null,updatedAt:string,pid:string)=>{await getDb().update(emailAttempts).set({status,providerId,updatedAt}).where(eq(emailAttempts.participantId,BigInt(pid)));};
  if (!readyForSes()) {
    const status: EmailStatus = process.env.EMAIL_MODE === 'ses' ? 'unavailable-not-sent' : 'mock-not-sent';
    await update(status, null, new Date().toISOString(), participantId);
    return emailLabel(status);
  }
  await update('pending', null, new Date().toISOString(), participantId);
  try {
    const client = new SESClient({ region: 'us-east-1', maxAttempts: 1 });
    const result = await client.send(new SendEmailCommand({
      Source: `Tech Woman <${process.env.SES_FROM}>`,
      Destination: { ToAddresses: [email] },
      Message: {
        Subject: { Data: 'Inscrição recebida | Tech Woman', Charset: 'UTF-8' },
        Body: { Text: { Data: `Recebemos sua inscrição no Tech Woman. Protocolo: ${protocol}. Consulte suas opções de mentoria pelo link individual exibido após o cadastro; a escolha não define horário.`, Charset: 'UTF-8' } },
      },
    }));
    if (!result.MessageId) throw new Error('SES não retornou identificador de aceite');
    await update('ses-accepted', result.MessageId, new Date().toISOString(), participantId);
    return emailLabel('ses-accepted');
  } catch {
    await update('ses-unconfirmed', null, new Date().toISOString(), participantId);
    return emailLabel('ses-unconfirmed');
  }
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
  ? { subject: 'Redefinição de senha | Tech Woman', text: `Seu código de redefinição de senha (válido por 30 minutos, uso único): ${secret}` }
  : { subject: 'Seu acesso | Tech Woman', text: `Sua senha temporária (válida por 24 horas) é: ${secret}\nEntre com ela e defina sua senha definitiva.` };

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
    if (done?.r === 'applied') result[status]++; else result.stale++;
  }
  return result;
}
