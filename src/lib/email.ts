import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { getDb, emailAttempts, choiceEmailAttempts } from './db';
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