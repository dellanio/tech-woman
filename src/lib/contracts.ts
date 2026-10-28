/** Contrato HTTP v1: estruturas reais e parsers fechados. Não registra endpoints futuros. */
import {createHash,randomUUID} from 'node:crypto';
export type SqlId=string;
export type Role='admin'|'team'|'mentor'|'participant';
export type UserStatus='pending_activation'|'active'|'disabled';
export type CohortStatus='draft'|'open'|'closed'|'cancelled';
export type EmailJobStatus='queued'|'sending'|'accepted'|'unconfirmed'|'failed'|'simulated'|'cancelled';
export type Tag='produto'|'dados'|'desenvolvimento'|'design';
export type Skill='comunicacao'|'analise'|'codigo'|'gestao';
export type ErrorCode='INVALID_JSON'|'INVALID_INPUT'|'AUTH_REQUIRED'|'INVALID_CREDENTIALS'|'FORBIDDEN'|'PASSWORD_CHANGE_REQUIRED'|'CSRF_REJECTED'|'NOT_FOUND'|'EMAIL_UNAVAILABLE'|'IDENTITY_RECONCILIATION_REQUIRED'|'COHORT_FULL'|'SCHEDULE_CONFLICT'|'COHORT_IN_USE'|'COHORT_NOT_OPEN'|'TOPIC_LIMIT'|'ALREADY_ENROLLED'|'IDEMPOTENCY_CONFLICT'|'RETRY_TRANSACTION'|'VERSION_MISMATCH'|'PRECONDITION_REQUIRED'|'RATE_LIMITED'|'MAINTENANCE'|'DEPENDENCY_UNAVAILABLE'|'INVALID_RESET'|'PROFILE_EXISTS';
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
 if(Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)throw new ContractError(['datetime']);
 const date=value.slice(0,10);const civil=new Date(date+'T12:00:00Z');if(Number.isNaN(civil.valueOf())||civil.toISOString().slice(0,10)!==date||Number.isNaN(Date.parse(value)))throw new ContractError(['datetime']);return new Date(value).toISOString();
}
const tags=['produto','dados','desenvolvimento','design'] as const;
const skills=['comunicacao','analise','codigo','gestao'] as const;
export type ParticipantRegistration={email:string;goal:'transition'|'growth'|'leadership';moment:'starting'|'working'|'returning';interests:Tag[];skills:Skill[];area:Tag|'outra';otherArea?:string;consent:true};
type ParticipantFields=Omit<ParticipantRegistration,'email'>;
function participantFields(p:Record<string,unknown>):ParticipantFields{
 const area=enumeration(p.area,[...tags,'outra'],'area');
 return {goal:enumeration(p.goal,['transition','growth','leadership'],'goal'),moment:enumeration(p.moment,['starting','working','returning'],'moment'),interests:list(p.interests,tags,3,'interests'),skills:list(p.skills,skills,4,'skills'),area,...(area==='outra'?{otherArea:text(p.otherArea,'otherArea',1,80)}:{}),consent:consent(p.consent)};
}
const PARTICIPANT_KEYS=['goal','moment','interests','skills','area','otherArea','consent'];
/** DTO do POST administrativo de participante (/api/v1/admin/participants). O cadastro público usa parseParticipantSignup. */
export function parseParticipantRegistration(value:unknown):ParticipantRegistration{const p=object(value,['email',...PARTICIPANT_KEYS]);return {email:email(p.email),...participantFields(p)};}
/** Cadastro público de participante (AJUSTE-INSCRICAO): diagnóstico + mentora escolhida no crossing + e-mail + senha definitiva + confirmação. */
export type ParticipantSignup=ParticipantRegistration&{mentor_ref:string;password:string;passwordConfirmation:string};
const MENTOR_REF=/^[A-Za-z0-9_-]{43}$/;
/** Mesma regra das demais senhas novas (12..128 code points); confirmação idêntica; sem cadastro sem credenciais nem crossing. */
export function parseParticipantSignup(value:unknown):ParticipantSignup{
 const p=object(value,['email','mentor_ref','password','passwordConfirmation',...PARTICIPANT_KEYS]);
 const out={email:email(p.email),...participantFields(p)};
 if(typeof p.mentor_ref!=='string'||!MENTOR_REF.test(p.mentor_ref))throw new ContractError(['mentor_ref']);
 if(typeof p.password!=='string'||[...p.password].length<12||[...p.password].length>128)throw new ContractError(['password']);
 if(p.passwordConfirmation!==p.password)throw new ContractError(['passwordConfirmation']);
 return {...out,mentor_ref:p.mentor_ref,password:p.password,passwordConfirmation:p.passwordConfirmation};
}
/** Preview do crossing (cadastro público): só o diagnóstico, sem e-mail, credenciais nem consentimento. */
export type ParticipantPreview=Omit<ParticipantFields,'consent'>;
const PREVIEW_KEYS=['goal','moment','interests','skills','area','otherArea'];
export function parseRegistrationPreview(value:unknown):ParticipantPreview{const {consent:_consent,...fields}=participantFields({...object(value,PREVIEW_KEYS),consent:true});return fields;}
/** Item público do crossing: referência opaca e nome (ou "(MENTORA)"). Nada além disso sai do servidor. */
export type CrossingChoice={mentor_ref:string;nome_exibicao:string};
/** Perfil de participante da própria sessão: mesmos dados de domínio, sem email/userId/roles. */
export function parseParticipantProfile(value:unknown):ParticipantFields{return participantFields(object(value,PARTICIPANT_KEYS));}
export type MentorRegistration={email:string;displayName:string;trajectory:string;specialties:Tag[];availability:string;legacyCapacity:number;consent:true};
type MentorFields=Omit<MentorRegistration,'email'>;
function mentorFields(p:Record<string,unknown>):MentorFields{return {displayName:text(p.displayName,'displayName',1,120),trajectory:text(p.trajectory,'trajectory',1,1000),specialties:list(p.specialties,tags,3,'specialties'),availability:text(p.availability,'availability',1,300),legacyCapacity:integer(p.legacyCapacity,1,50,'legacyCapacity'),consent:consent(p.consent)};}
const MENTOR_KEYS=['displayName','trajectory','specialties','availability','legacyCapacity','consent'];
export function parseMentorRegistration(value:unknown):MentorRegistration{const p=object(value,['email',...MENTOR_KEYS]);return {email:email(p.email),...mentorFields(p)};}
export function parseMentorProfile(value:unknown):MentorFields{return mentorFields(object(value,MENTOR_KEYS));}
export function parseLogin(value:unknown){const p=object(value,['email','password']);if(typeof p.password!=='string'||p.password.length<1||p.password.length>1024)throw new ContractError(['password']);return {email:email(p.email),password:p.password};}
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
export const registrationReceived:RegistrationReceived={status:'received',next:'check_email'};
/** Cadastro de participante: conta nova ou e-mail indisponível são indistinguíveis; quem acabou de criar a conta entra com a senha escolhida. */
export type ParticipantSignupReceived={status:'received';next:'login'};
export const participantSignupReceived:ParticipantSignupReceived={status:'received',next:'login'};
export type ForgotReceived={status:'received'};
export const forgotReceived:ForgotReceived={status:'received'};
export type TemporaryPasswordQueued={jobId:string;status:'queued'};
export const parsePasswordForgot=(value:unknown)=>({email:email(object(value,['email']).email)});
export const parseTemporaryPasswordRequest=(value:unknown):{confirm:true}=>{const p=object(value,['confirm']);if(p.confirm!==true)throw new ContractError(['confirm']);return {confirm:true};};
export const parsePasswordReset=(value:unknown)=>{const p=object(value,['token','newPassword']);if(typeof p.token!=='string'||p.token.length<1||p.token.length>256)throw new ContractError(['token']);if(typeof p.newPassword!=='string'||[...p.newPassword].length<12||[...p.newPassword].length>128)throw new ContractError(['newPassword']);return {token:p.token,newPassword:p.newPassword};};

// ---- Contas administrativas (WP-002 Task 3) ----
const UUID_RE=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid=(value:unknown):value is string=>typeof value==='string'&&UUID_RE.test(value);
export type ManagedRole='participant'|'mentor';
const MANAGED_ROLES=['participant','mentor'] as const;
function managedRoles(value:unknown,min:number):ManagedRole[]{
 if(!Array.isArray(value)||value.length<min||value.length>2||new Set(value).size!==value.length)throw new ContractError(['roles']);
 return value.map(v=>enumeration(v,MANAGED_ROLES,'roles'));
}
export type AdminUserPatch={email?:string;status?:'active'|'disabled';roles?:ManagedRole[]};
/** PATCH fechado: nunca id/hash/senha/userId/admin/team; ao menos um campo. */
export function parseAdminUserPatch(value:unknown):AdminUserPatch{
 const p=object(value,['email','status','roles']);if(!Object.keys(p).length)throw new ContractError(['body']);
 const patch:AdminUserPatch={};
 if('email' in p)patch.email=email(p.email);
 if('status' in p)patch.status=enumeration<'active'|'disabled'>(p.status,['active','disabled'],'status');
 if('roles' in p)patch.roles=managedRoles(p.roles,0);
 return patch;
}
const nested=<T>(key:string,parse:()=>T):T=>{try{return parse();}catch(error){if(error instanceof ContractError)throw new ContractError(error.fields.map(f=>`${key}.${f}`));throw error;}};
export type AdminUserCreate={email:string;roles:ManagedRole[];participant?:ReturnType<typeof parseParticipantProfile>;mentor?:ReturnType<typeof parseMentorProfile>};
/** roles deve corresponder exatamente aos domínios fornecidos; sem usuário órfão, sem admin/team. */
export function parseAdminUserCreate(value:unknown):AdminUserCreate{
 const p=object(value,['email','roles','participant','mentor']);const roles=managedRoles(p.roles,1);
 const out:AdminUserCreate={email:email(p.email),roles};
 if('participant' in p)out.participant=nested('participant',()=>parseParticipantProfile(p.participant));
 if('mentor' in p)out.mentor=nested('mentor',()=>parseMentorProfile(p.mentor));
 if(roles.includes('participant')!==!!out.participant)throw new ContractError(['roles','participant']);
 if(roles.includes('mentor')!==!!out.mentor)throw new ContractError(['roles','mentor']);
 return out;
}
export const encodeCursor=(id:string)=>Buffer.from(JSON.stringify({id}),'utf8').toString('base64url');
export function decodeCursor(value:string):string{
 try{const parsed:unknown=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));
  if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&Object.keys(parsed).join()==='id'&&isUuid((parsed as {id?:unknown}).id))return String((parsed as {id:string}).id).toLowerCase();}catch{/* cursor inválido */}
 throw new ContractError(['cursor']);
}
export function parseListQuery(query:{cursor?:unknown;limit?:unknown}):{after:string|null;limit:number}{
 const limit=query.limit===undefined||query.limit===null?20:integer(query.limit,1,100,'limit');
 if(query.cursor===undefined||query.cursor===null)return {after:null,limit};
 if(typeof query.cursor!=='string'||query.cursor.length>200)throw new ContractError(['cursor']);
 return {after:decodeCursor(query.cursor),limit};
}
const canonical=(value:unknown):unknown=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,v])=>[k,canonical(v)])):value;
/** Hash do corpo canônico (chaves ordenadas) para idempotência. */
export const canonicalHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

export const parsePasswordChange=(value:unknown)=>{const p=object(value,['currentPassword','newPassword']);if(typeof p.currentPassword!=='string'||p.currentPassword.length<1||p.currentPassword.length>1024)throw new ContractError(['currentPassword']);if(typeof p.newPassword!=='string'||[...p.newPassword].length<12||[...p.newPassword].length>128)throw new ContractError(['newPassword']);return {currentPassword:p.currentPassword,newPassword:p.newPassword};};
export const parseIdempotencyKey=(value:string|null):string=>{if(!isUuid(value))throw new ContractError(['Idempotency-Key']);return value.toLowerCase();};
export type SessionPublicDto=SessionDto|{state:'password_change_required';expiresAt:string};

// ---- Agenda e CRUD de domínio (WP-003) ----
function patchObject(value:unknown,allowed:string[]){const p=object(value,allowed);if(!Object.keys(p).length)throw new ContractError(['body']);return p;}
function boolean(value:unknown,field:string){if(typeof value!=='boolean')throw new ContractError([field]);return value;}
export function parseTopicPatch(value:unknown){
 const p=patchObject(value,['name','description','active']);
 return {...('name' in p?{name:text(p.name,'name',1,120)}:{}),...('description' in p?{description:text(p.description,'description',0,1000)}:{}),...('active' in p?{active:boolean(p.active,'active')}:{})};
}
export function parseMentorTopicPatch(value:unknown){const p=patchObject(value,['position']);return {position:integer(p.position,1,2,'position') as 1|2};}
export function parseCohortPatch(value:unknown){
 const p=patchObject(value,['startsAt','endsAt','capacity','status']);
 const out={...('startsAt' in p?{startsAt:parseInstant(p.startsAt)}:{}),...('endsAt' in p?{endsAt:parseInstant(p.endsAt)}:{}),...('capacity' in p?{capacity:integer(p.capacity,1,20,'capacity')}:{}),...('status' in p?{status:enumeration<CohortStatus>(p.status,['draft','open','closed','cancelled'],'status')}:{})};
 if(out.startsAt&&out.endsAt&&out.endsAt<=out.startsAt)throw new ContractError(['endsAt']);return out;
}
export function parseReorder(value:unknown){const p=object(value,['firstId','secondId']);const firstId=parseSqlId(p.firstId),secondId=parseSqlId(p.secondId);if(firstId===secondId)throw new ContractError(['secondId']);return {firstId,secondId};}
export function parseReassign(value:unknown){const p=object(value,['cohortId','confirm']);if(p.confirm!==true)throw new ContractError(['confirm']);return {cohortId:parseSqlId(p.cohortId),confirm:true as const};}
export function parseMatchCreate(value:unknown){const p=object(value,['participantId','mentorId']);return {participantId:parseSqlId(p.participantId),mentorId:parseSqlId(p.mentorId)};}
export function parseMatchPatch(value:unknown){const p=patchObject(value,['status']);return {status:enumeration(p.status,['suggested','rejected'],'status')};}
export function parseParticipantPatch(value:unknown){
 const p=patchObject(value,['goal','moment','interests','skills','area','otherArea','active']);
 if('otherArea' in p&&p.area!=='outra')throw new ContractError(['otherArea']);
 const area='area' in p?enumeration(p.area,[...tags,'outra'],'area'):undefined;
 return {...('goal' in p?{goal:enumeration(p.goal,['transition','growth','leadership'],'goal')}:{}),...('moment' in p?{moment:enumeration(p.moment,['starting','working','returning'],'moment')}:{}),...('interests' in p?{interests:list(p.interests,tags,3,'interests')}:{}),...('skills' in p?{skills:list(p.skills,skills,4,'skills')}:{}),...(area?{area}:{}),...(area==='outra'?{otherArea:text(p.otherArea,'otherArea',1,80)}:{}),...('active' in p?{active:boolean(p.active,'active')}:{})};
}
export function parseMentorPatch(value:unknown){
 const p=patchObject(value,['displayName','trajectory','specialties','availability','legacyCapacity','active']);
 return {...('displayName' in p?{displayName:text(p.displayName,'displayName',1,120)}:{}),...('trajectory' in p?{trajectory:text(p.trajectory,'trajectory',1,1000)}:{}),...('specialties' in p?{specialties:list(p.specialties,tags,3,'specialties')}:{}),...('availability' in p?{availability:text(p.availability,'availability',1,300)}:{}),...('legacyCapacity' in p?{legacyCapacity:integer(p.legacyCapacity,1,50,'legacyCapacity')}:{}),...('active' in p?{active:boolean(p.active,'active')}:{})};
}
export const encodeSqlCursor=(id:string)=>encodeCursor(parseSqlId(id));
export function parseDomainListQuery(query:{cursor?:unknown;limit?:unknown}):{after:string|null;limit:number}{
 const limit=query.limit===undefined||query.limit===null?20:integer(query.limit,1,100,'limit');
 if(query.cursor===undefined||query.cursor===null)return {after:null,limit};
 if(typeof query.cursor!=='string'||query.cursor.length>200)throw new ContractError(['cursor']);
 try{const parsed:unknown=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'));const p=object(parsed,['id']);return {after:parseSqlId(p.id),limit};}catch{throw new ContractError(['cursor']);}
}

/** POST antigo de mentora: `capacity` (sem displayName obrigatório). Mesmos limites do contrato v1; fecha campos desconhecidos. */
export function parseLegacyMentorRegistration(value:unknown):{email:string;displayName:string|null;trajectory:string;specialties:Tag[];availability:string;legacyCapacity:number;consent:true}{
 const p=object(value,['email','displayName','trajectory','specialties','availability','capacity','consent']);
 return {email:email(p.email),displayName:p.displayName===undefined?null:text(p.displayName,'displayName',1,120),trajectory:text(p.trajectory,'trajectory',1,1000),specialties:list(p.specialties,tags,3,'specialties'),availability:text(p.availability,'availability',1,300),legacyCapacity:integer(p.capacity,1,50,'capacity'),consent:consent(p.consent)};
}
