/**
 * Fachada dos caminhos antigos (CONTRATOS §7). Nenhuma regra própria: cada adaptador é UMA operação SQL autorizada (internal.api_legacy_*)
 * pelo mesmo executor das operações v1 (agenda.invoke: retry integral, erros traduzidos sem SQL). Agenda e recomendações ficam em agenda.ts /
 * recommendations.ts; aqui só o formato de resposta antigo, sem aprovação, reserva por capacidade ou match criado por token.
 */
import { sql } from 'drizzle-orm';
import { identitySession, login, logout } from './identity';
import { tokenDigest } from './db';
import { emailLabel } from './email';
import { HttpError } from './auth';
import { ContractError, parseSqlId } from './contracts';
import { digestOf, invoke, newRequestId } from './agenda';

export const mentorDeadline=process.env.MENTOR_DEADLINE||'2026-10-31T02:59:59.999Z';
export const mentorRegistrationOpen=()=>!Number.isNaN(Date.parse(mentorDeadline))&&Date.now()<=Date.parse(mentorDeadline);

type Body=Record<string,unknown>;
type LegacyStatus={status:string};
const NEW_FLOW={
 approve:'Aprovação sem turma foi substituída: a participante ativa a conta e reserva mentora e horário em /api/v1/me/enrollments.',
 reassign:'Realocação exige turma: use POST /api/v1/admin/enrollments/{id}/reassign com cohortId.',
 cancel:'Não há par legado aprovado para cancelar; reservas com horário são canceladas em DELETE /api/v1/admin/enrollments/{id}.',
} as const;
/** IDs antigos chegavam como string decimal ou number seguro; ambos viram a string bigint do contrato (domínio, nunca userId). */
const legacyId=(value:unknown,field:string)=>{
 const raw=typeof value==='number'&&Number.isSafeInteger(value)?String(value):value;
 try{return parseSqlId(raw);}catch{throw new ContractError([field]);}
};
/** DTO fechado: objeto JSON, só as chaves da ação; IDs normalizados. A operação SQL valida de novo. */
function legacyBody(value:unknown,keys:readonly string[],ids:readonly string[]):Body{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ContractError(['body']);
 const input=value as Body;const extra=Object.keys(input).filter(k=>!keys.includes(k));
 if(extra.length)throw new ContractError(extra);
 return Object.fromEntries(Object.entries(input).map(([k,v])=>[k,ids.includes(k)?legacyId(v,k):v]));
}
/** 422 cohortId das operações sem turma recebe a instrução do fluxo novo. */
async function adapt<T>(run:Promise<T>,instruction:Partial<Record<'cohortId'|'participantId',string>>):Promise<T>{
 try{return await run;}catch(error){
  const field=error instanceof HttpError&&error.code==='INVALID_INPUT'?error.fields[0]:undefined;
  const message=field==='cohortId'||field==='participantId'?instruction[field]:undefined;
  throw message&&error instanceof HttpError?new HttpError('INVALID_INPUT',error.fields,{},message):error;
 }
}

export type OverviewChoice={mentorId:string;mentorEmail:string;demo:boolean;capacity:number;occupied:number;score:number;reasons:string[]};
export type Overview={participants:{id:string;protocol:string;email:string;area:string|null;goal:string;moment:string;interests:string[];approvedMentorId:string|null;choices:OverviewChoice[]}[];
 mentors:{id:string;email:string;demo:boolean;trajectory:string;specialties:string[];availability:string;capacity:number;occupied:number;active:boolean}[]};
/** Leitura admin/team; o banco revalida o ator e omite toda linha protegida (inclusive sugestões e par legado exibido). */
export const adminOverview=(token:string)=>invoke<Overview>(sql`select internal.api_legacy_overview(${digestOf(token)}) as r`);

export function decide(token:string,body:unknown){
 const dto=legacyBody(body,['participantId','mentorId','action'],['participantId','mentorId']);
 return adapt(invoke<LegacyStatus>(sql`select internal.api_legacy_decide(${digestOf(token)}, ${newRequestId()}::uuid, ${JSON.stringify(dto)}::jsonb) as r`),{cohortId:NEW_FLOW.approve});
}
export function adminChange(token:string,body:unknown){
 const dto=legacyBody(body,['action','participantId','mentorId'],['participantId','mentorId']);
 return adapt(invoke<LegacyStatus>(sql`select internal.api_legacy_change(${digestOf(token)}, ${newRequestId()}::uuid, ${JSON.stringify(dto)}::jsonb) as r`),{cohortId:NEW_FLOW.reassign,...(dto.action==='cancel'&&dto.participantId!==undefined?{participantId:NEW_FLOW.cancel}:{})});
}
export type EventContentDto={description:string;venue:string;agenda:string;speakers:string;date:string;duration:string};
/** Conteúdo textual do evento (não é Agenda): só admin, ator revalidado sob lock, DTO fechado e auditoria no banco. */
export const saveEventAs=(token:string,body:unknown)=>invoke<EventContentDto>(sql`select internal.api_legacy_event_save(${digestOf(token)}, ${newRequestId()}::uuid, ${JSON.stringify(body)}::jsonb) as r`);

export type LegacyState={protocol:string;email:string;status:string;emailStatus:string;choiceEmailStatus:string|null;
 mentor:{email:string;displayName:string;demo:boolean;trajectory:string;reasons:string[]}|null};
const LEGACY_TOKEN=/^[a-f0-9]{64}$/;
const ACTIVATION='Para escolher mentora e horário, ative sua conta pelo e-mail de acesso e entre no site; o histórico deste link continua disponível.';
/**
 * Estado do link antigo, buscado só pelo hash do token. `mentor.email` mantém a chave lida pela página antiga, mas carrega o rótulo público
 * da mentora (displayName/demo/fallback) — nunca o endereço. null = 404 (inválido, ativado, revogado ou protegido).
 */
export async function stateFor(token:string):Promise<LegacyState|null>{
 if(!LEGACY_TOKEN.test(token))return null;
 const row=await invoke<LegacyState|null>(sql`select internal.api_legacy_state(${tokenDigest(token)}) as r`,'catalog');
 if(!row)return null;
 return {...row,emailStatus:emailLabel(row.emailStatus),choiceEmailStatus:row.choiceEmailStatus===null?null:emailLabel(row.choiceEmailStatus)};
}
export type LegacyChoices={choices:never[];assigned:boolean;next:'activate_account';instruction:string};
/** GET /api/choice: só histórico e instrução de ativação; escolha nova é exclusiva da sessão v1 reconciliada. */
export async function legacyChoices(token:string):Promise<LegacyChoices>{
 const state=await stateFor(token);if(!state)throw new HttpError('NOT_FOUND');
 return {choices:[],assigned:state.mentor!==null,next:'activate_account',instruction:ACTIVATION};
}
/** POST /api/choice: nunca cria match/reserva por token (duplicatas legadas não contornam conflito de agenda) → 409 de reconciliação. */
export async function legacyChoose(token:string,body:unknown):Promise<never>{
 legacyBody(body,['mentorId'],['mentorId']);
 if(!await stateFor(token))throw new HttpError('NOT_FOUND');
 throw new HttpError('IDENTITY_RECONCILIATION_REQUIRED',[],{},ACTIVATION);
}

/** Compatibilidade: autentica pela identidade nova e não deixa sessão (a rota antiga já cria a própria). Sem sessão stateless. */
export async function authenticate(email:string,password:string){
 const result=await login(email,password);if(!result)return null;
 const session=await identitySession(result.token);await logout(result.token);
 if(!session||session.scope!=='full')return null;
 const role=session.roles.includes('admin')?'owner' as const:session.roles.includes('team')?'member' as const:null;
 return role?{email:session.email,role}:null;
}
