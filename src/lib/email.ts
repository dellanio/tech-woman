import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses';
import { sqlite } from './db';

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
export async function confirmChoice(participantId:number, mentorId:number, email:string, protocol:string, mentorEmail:string):Promise<string> {
  const update = sqlite.prepare('INSERT INTO choice_email_attempt(participant_id,mentor_id,status,provider_id,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(participant_id) DO UPDATE SET mentor_id=excluded.mentor_id,status=excluded.status,provider_id=excluded.provider_id,updated_at=excluded.updated_at');
  const status:EmailStatus = !readyForSes() ? (process.env.EMAIL_MODE==='ses'?'unavailable-not-sent':'mock-not-sent') : 'pending';
  update.run(participantId,mentorId,status,null,new Date().toISOString());
  if (!readyForSes()) return emailLabel(status);
  try {
    const result=await new SESClient({region:'us-east-1',maxAttempts:1}).send(new SendEmailCommand({
      Source:`Tech Woman <${process.env.SES_FROM}>`, Destination:{ToAddresses:[email]},
      Message:{Subject:{Data:'Sua mentoria escolhida | Tech Woman',Charset:'UTF-8'},Body:{Text:{Data:`Protocolo ${protocol}. Você escolheu a mentora ${mentorEmail} para uma mentoria, sem horário definido. Consulte seu link individual para conferir o estado atualizado.`,Charset:'UTF-8'}}}
    }));
    if (!result.MessageId) throw new Error('Aceite sem identificador');
    update.run(participantId,mentorId,'ses-accepted',result.MessageId,new Date().toISOString());
    return emailLabel('ses-accepted');
  } catch {
    update.run(participantId,mentorId,'ses-unconfirmed',null,new Date().toISOString());
    return emailLabel('ses-unconfirmed');
  }
}
export async function confirmRegistration(participantId: number, email: string, protocol: string): Promise<string> {
  const update = sqlite.prepare('UPDATE email_attempt SET status=?, provider_id=?, updated_at=? WHERE participant_id=?');
  if (!readyForSes()) {
    const status: EmailStatus = process.env.EMAIL_MODE === 'ses' ? 'unavailable-not-sent' : 'mock-not-sent';
    update.run(status, null, new Date().toISOString(), participantId);
    return emailLabel(status);
  }
  update.run('pending', null, new Date().toISOString(), participantId);
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
    update.run('ses-accepted', result.MessageId, new Date().toISOString(), participantId);
    return emailLabel('ses-accepted');
  } catch {
    update.run('ses-unconfirmed', null, new Date().toISOString(), participantId);
    return emailLabel('ses-unconfirmed');
  }
}
