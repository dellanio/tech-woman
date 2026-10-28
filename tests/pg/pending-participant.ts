/**
 * Fixture do estado LEGADO "conta pendente de participante" (cadastro público anterior à migration 31, AJUSTE-INSCRICAO).
 * O cadastro público agora cria conta active com senha definitiva e nunca enfileira e-mail; contas pendentes antigas continuam existindo
 * em produção e seguem pelo worker/forgot/admin intocados. Testes desses fluxos criam o mesmo conjunto de linhas que o cadastro antigo
 * gravava (app_user pending_activation, papel, perfil ligado e job 'registration' sem payload), num único statement, como dono do banco.
 * E-mail já existente (comparação por email_key) não muda nada — mesma neutralidade do cadastro antigo. Sem testes próprios.
 */
import type {Client,Pool,PoolClient} from 'pg';

export type PendingProfile={goal?:string;moment?:string;interests?:string[];skills?:string[];area?:string};
const SQL=`with u as (
  insert into public.app_user(id,email,status) values(gen_random_uuid(),btrim($1),'pending_activation')
  on conflict on constraint app_user_email_key_unique do nothing returning id,email),
 r as (insert into public.user_role(user_id,role) select id,'participant' from u),
 p as (insert into public.participant(email,goal,moment,interests,skills,area,token_hash,consent_version,consent_at,user_id)
  select email,$2,$3,$4::jsonb,$5::jsonb,$6,encode(sha256(convert_to(gen_random_uuid()::text||gen_random_uuid()::text,'UTF8')),'hex'),'v1',now(),id from u returning id,user_id)
 insert into public.email_job(id,user_id,kind,generation,status,dedupe_key,participant_id)
  select gen_random_uuid(),user_id,'registration',0,'queued','registration:'||user_id::text,id from p returning user_id::text`;

/** Devolve o id da conta criada, ou null quando o e-mail já existia (nada muda). */
export async function pendingParticipant(db:Pool|Client|PoolClient,email:string,profile:PendingProfile={}):Promise<string|null>{
 const r=await db.query(SQL,[email,profile.goal??'growth',profile.moment??'working',JSON.stringify(profile.interests??['dados']),JSON.stringify(profile.skills??['codigo']),profile.area??'dados']);
 return r.rows[0]?.user_id??null;
}
