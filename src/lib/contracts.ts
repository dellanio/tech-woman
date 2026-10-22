/** Contrato HTTP v1: estruturas reais e parsers fechados. Não registra endpoints futuros. */
import {randomUUID} from 'node:crypto';
export type SqlId=string;
export type Role='admin'|'team'|'mentor'|'participant';
export type UserStatus='pending_activation'|'active'|'disabled';
export type CohortStatus='draft'|'open'|'closed'|'cancelled';
export type EmailJobStatus='queued'|'sending'|'accepted'|'unconfirmed'|'failed'|'simulated'|'cancelled';
export type Tag='produto'|'dados'|'desenvolvimento'|'design';
export type Skill='comunicacao'|'analise'|'codigo'|'gestao';
export type ErrorCode='INVALID_JSON'|'INVALID_INPUT'|'AUTH_REQUIRED'|'INVALID_CREDENTIALS'|'FORBIDDEN'|'PASSWORD_CHANGE_REQUIRED'|'CSRF_REJECTED'|'NOT_FOUND'|'EMAIL_UNAVAILABLE'|'IDENTITY_RECONCILIATION_REQUIRED'|'COHORT_FULL'|'SCHEDULE_CONFLICT'|'COHORT_IN_USE'|'COHORT_NOT_OPEN'|'TOPIC_LIMIT'|'ALREADY_ENROLLED'|'IDEMPOTENCY_CONFLICT'|'RETRY_TRANSACTION'|'VERSION_MISMATCH'|'PRECONDITION_REQUIRED'|'RATE_LIMITED'|'MAINTENANCE'|'DEPENDENCY_UNAVAILABLE'|'INVALID_RESET';
export type ApiSuccess<T>={data:T;requestId:string};
export type ApiCollection<T>=ApiSuccess<T[]>&{page:{nextCursor:string|null}};
export type ApiError={error:{code:ErrorCode;message:string;fields:string[]};requestId:string};
export const apiSuccess=<T>(data:T):ApiSuccess<T>=>({data,requestId:randomUUID()});
export const apiError=(code:ErrorCode,message:string,fields:string[]=[]):ApiError=>({error:{code,message,fields},requestId:randomUUID()});
export class ContractError extends Error {readonly code='INVALID_INPUT';readonly status=422;constructor(public fields:string[]=[]){super('Confira os dados informados.');}}
function object(value:unknown,allowed:string[]):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))throw new ContractError();const input=value as Record<string,unknown>;if(Object.keys(input).some(k=>!allowed.includes(k)))throw new ContractError(Object.keys(input).filter(k=>!allowed.includes(k)));return input;}
function text(value:unknown,field:string,min:number,max:number){if(typeof value!=='string'||value.trim().length<min||value.trim().length>max)throw new ContractError([field]);return value.trim();}
function email(value:unknown){const result=text(value,'email',3,254);if(!/^[\x21-\x7e]+@[^@\s]+\.[^@\s]+$/.test(result)||result.split('@').length!==2)throw new ContractError(['email']);return result;}
function enumeration<T extends string>(value:unknown,allowed:readonly T[],field:string):T{if(typeof value!=='string'||!allowed.includes(value as T))throw new ContractError([field]);return value as T;}
function integer(value:unknown,min:number,max:number,field:string){if(typeof value!=='number'||!Number.isInteger(value)||value<min||value>max)throw new ContractError([field]);return value;}
function list<T extends string>(value:unknown,allowed:readonly T[],max:number,field:string):T[]{if(!Array.isArray(value)||value.length<1||value.length>max||new Set(value).size!==value.length)throw new ContractError([field]);return value.map(v=>enumeration(v,allowed,field));}
function consent(value:unknown):true{if(value!==true)throw new ContractError(['consent']);return true;}
export function parseSqlId(value:unknown):SqlId{if(typeof value!=='string'||!/^([1-9]\d*)$/.test(value)||value.length>19||BigInt(value)>BigInt('9223372036854775807'))throw new ContractError(['id']);return value;}
export function parseInstant(value:unknown):string{
 if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value))throw new ContractError(['datetime']);
 const date=value.slice(0,10);const civil=new Date(date+'T12:00:00Z');if(Number.isNaN(civil.valueOf())||civil.toISOString().slice(0,10)!==date||Number.isNaN(Date.parse(value)))throw new ContractError(['datetime']);return new Date(value).toISOString();
}
const tags=['produto','dados','desenvolvimento','design'] as const;
const skills=['comunicacao','analise','codigo','gestao'] as const;
export type ParticipantRegistration={email:string;goal:'transition'|'growth'|'leadership';moment:'starting'|'working'|'returning';interests:Tag[];skills:Skill[];area:Tag|'outra';otherArea?:string;consent:true};
export function parseParticipantRegistration(value:unknown):ParticipantRegistration{
 const p=object(value,['email','goal','moment','interests','skills','area','otherArea','consent']);const area=enumeration(p.area,[...tags,'outra'],'area');
 return {email:email(p.email),goal:enumeration(p.goal,['transition','growth','leadership'],'goal'),moment:enumeration(p.moment,['starting','working','returning'],'moment'),interests:list(p.interests,tags,3,'interests'),skills:list(p.skills,skills,4,'skills'),area,...(area==='outra'?{otherArea:text(p.otherArea,'otherArea',1,80)}:{}),consent:consent(p.consent)};
}
export type MentorRegistration={email:string;displayName:string;trajectory:string;specialties:Tag[];availability:string;legacyCapacity:number;consent:true};
export function parseMentorRegistration(value:unknown):MentorRegistration{const p=object(value,['email','displayName','trajectory','specialties','availability','legacyCapacity','consent']);return {email:email(p.email),displayName:text(p.displayName,'displayName',1,120),trajectory:text(p.trajectory,'trajectory',1,1000),specialties:list(p.specialties,tags,3,'specialties'),availability:text(p.availability,'availability',1,300),legacyCapacity:integer(p.legacyCapacity,1,50,'legacyCapacity'),consent:consent(p.consent)};}
export function parseLogin(value:unknown){const p=object(value,['email','password']);if(typeof p.password!=='string'||p.password.length<1||p.password.length>128)throw new ContractError(['password']);return {email:email(p.email),password:p.password};}
export function parseTopic(value:unknown){const p=object(value,['slug','name','description']);const slug=text(p.slug,'slug',1,80);if(!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug))throw new ContractError(['slug']);return {slug,name:text(p.name,'name',1,120),description:p.description===undefined?'':text(p.description,'description',0,1000)};}
export function parseMentorTopic(value:unknown){const p=object(value,['topicId','position']);return {topicId:parseSqlId(p.topicId),position:integer(p.position,1,2,'position') as 1|2};}
export function parseCohort(value:unknown){const p=object(value,['startsAt','endsAt','capacity','status']);const startsAt=parseInstant(p.startsAt),endsAt=parseInstant(p.endsAt);if(endsAt<=startsAt)throw new ContractError(['endsAt']);return {startsAt,endsAt,capacity:integer(p.capacity,1,20,'capacity'),status:enumeration(p.status,['draft','open'],'status')};}
export function parseEnrollment(value:unknown){const p=object(value,['cohortId']);return {cohortId:parseSqlId(p.cohortId)};}
export type Versioned={id:SqlId;version:string};
export type TopicDto=Versioned&{slug:string;name:string;description:string;active:boolean};
export type MentorTopicDto=Versioned&{mentorId:SqlId;topicId:SqlId;position:1|2};
export type CohortDto=Versioned&{topic:{id:SqlId;name:string};startsAt:string;endsAt:string;timeZone:'America/Recife';capacity:number;occupied:number;available:number};
export type EnrollmentDto={id:SqlId;cohortId:SqlId;status:'active'|'cancelled';startsAt:string;endsAt:string};
export type MentorChoiceDto={id:SqlId;displayName:string;demo:boolean;trajectory:string;specialties:string[];score?:number;reasons?:string[]};
export type UserDto={id:string;email:string;status:UserStatus;roles:Role[];version:string};
export type RegistrationReceived={status:'received';next:'check_email'};
export type LoginState={state:'authenticated'|'password_change_required'};
export type SessionDto={user:{id:string;email:string;roles:Role[]};state:'authenticated'|'password_change_required';expiresAt:string};
export type LegacyMatchDto={id:SqlId;mentorId:SqlId;status:string;origin:'legacy';enrollmentId:null};
