import { getDb, participants, mentors, matches, emailAttempts, choiceEmailAttempts, users, userRoles, tokenDigest, newToken, verifyPassword, type Participant, type Mentor } from './db';
import { eq, and, sql } from 'drizzle-orm';
import { confirmRegistration, emailLabel } from './email';

const tags = ['produto','dados','desenvolvimento','design'] as const;
export const areas = [...tags,'outra'] as const;
export const goals = ['transition','growth','leadership'] as const;
export const moments = ['starting','working','returning'] as const;
export const mentorDeadline=process.env.MENTOR_DEADLINE||'2026-10-31T02:59:59.999Z';
export const mentorRegistrationOpen=()=>!Number.isNaN(Date.parse(mentorDeadline))&&Date.now()<=Date.parse(mentorDeadline);
type Input=Record<string,unknown>;
type Store=Pick<ReturnType<typeof getDb>,'select'|'insert'|'update'|'execute'>;
const isText=(value:unknown,max=400)=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max;
const emailValid=(value:unknown)=>typeof value==='string'&&/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)&&value.length<=254;
const list=(value:unknown)=>Array.isArray(value)&&value.length>0&&value.length<=3&&new Set(value).size===value.length&&value.every(v=>tags.includes(v));
const skillList=(value:unknown)=>Array.isArray(value)&&value.length>0&&value.length<=4&&new Set(value).size===value.length&&value.every(v=>['comunicacao','analise','codigo','gestao'].includes(v));
export class Invalid extends Error { constructor(message:string,public status=400){super(message);} }
export function legacyId(value:unknown):bigint { if((typeof value!=='string'||!/^\d+$/.test(value))&&(typeof value!=='number'||!Number.isSafeInteger(value))) throw new Invalid('Identificador inválido.');const id=BigInt(value as string|number);if(id<=BigInt(0)||id>BigInt('9223372036854775807')) throw new Invalid('Identificador inválido.');return id; }
export async function createParticipant(input:Input){
 if(!emailValid(input.email)||!goals.includes(input.goal as typeof goals[number])||!moments.includes(input.moment as typeof moments[number])||!list(input.interests)||!skillList(input.skills)||!areas.includes(input.area as typeof areas[number])||(input.area==='outra'&&!isText(input.otherArea,80))||input.consent!==true) throw new Invalid('Confira os campos, área de atuação e consentimento para continuar.');
 const token=newToken(),email=String(input.email).trim().toLowerCase();
 const entry=await getDb().transaction(async tx=>{
  const [p]=await tx.insert(participants).values({email,goal:String(input.goal),moment:String(input.moment),interests:input.interests as string[],skills:input.skills as string[],area:input.area==='outra'?`outra: ${String(input.otherArea).trim()}`:String(input.area),tokenHash:tokenDigest(token),consentVersion:'v1',consentAt:new Date().toISOString()}).returning();
  await tx.insert(emailAttempts).values({participantId:p.id,status:'mock-not-sent',updatedAt:new Date().toISOString()});return p;
 });
 const protocol=`TW-${String(entry.id).padStart(5,'0')}`;
 return {protocol,token,emailStatus:await confirmRegistration(String(entry.id),email,protocol)};
}
export async function createMentor(input:Input){
 if(!mentorRegistrationOpen()) throw new Invalid('Cadastro de mentoras encerrado.',403);
 if(!emailValid(input.email)||!isText(input.trajectory,1000)||!list(input.specialties)||!isText(input.availability,300)||!Number.isInteger(input.capacity)||Number(input.capacity)<1||Number(input.capacity)>50||input.consent!==true) throw new Invalid('Preencha trajetória, especialidades, disponibilidade, capacidade e consentimento.');
 const [entry]=await getDb().insert(mentors).values({email:String(input.email).trim().toLowerCase(),trajectory:String(input.trajectory).trim(),specialties:input.specialties as string[],availability:String(input.availability).trim(),capacity:Number(input.capacity),active:true}).returning({id:mentors.id});return {protocol:`M-${String(entry.id).padStart(5,'0')}`};
}
const approvedCondition=(p:bigint)=>and(eq(matches.participantId,p),eq(matches.status,'approved'),eq(matches.origin,'legacy'));
export async function stateFor(token:string){
 if(!/^[a-f0-9]{64}$/.test(token)) return null;
 const [p]=await getDb().select().from(participants).where(and(eq(participants.tokenHash,tokenDigest(token)),sql`${participants.legacyAccessRevokedAt} is null`));if(!p)return null;
 const [approved]=await getDb().select({mentor:mentors,reasons:matches.reasons}).from(matches).innerJoin(mentors,eq(mentors.id,matches.mentorId)).where(approvedCondition(p.id));
 const [attempt]=await getDb().select().from(emailAttempts).where(eq(emailAttempts.participantId,p.id));
 const [choice]=await getDb().select().from(choiceEmailAttempts).where(eq(choiceEmailAttempts.participantId,p.id));
 return {protocol:`TW-${String(p.id).padStart(5,'0')}`,email:p.email,status:approved?'Mentoria reservada':'Aguardando escolha ou revisão da equipe',emailStatus:emailLabel(attempt?.status||'unavailable-not-sent'),choiceEmailStatus:approved&&choice?emailLabel(choice.status):null,mentor:approved?{email:approved.mentor.demo?approved.mentor.demoName:approved.mentor.email,demo:approved.mentor.demo,trajectory:approved.mentor.trajectory,reasons:approved.reasons}:null};
}
async function approvedCount(mentorId:bigint,store:Store=getDb()){ const [entry]=await store.select({count:sql<number>`count(*)::int`}).from(matches).where(and(eq(matches.mentorId,mentorId),eq(matches.status,'approved'),eq(matches.origin,'legacy')));return entry.count; }
function ranking(p:Participant,m:Mentor){
 const objectives:Record<string,string[]>={transition:['desenvolvimento','design','produto','dados'],growth:['produto','dados'],leadership:['produto','design']};
 const goalMatches=m.specialties.filter(v=>(objectives[p.goal]||[]).includes(v)&&p.interests.includes(v));const shared=m.specialties.filter(v=>p.interests.includes(v));
 const skillMap:Record<string,string>={codigo:'desenvolvimento',analise:'dados',comunicacao:'produto',gestao:'design'};const skillMatches=p.skills.filter(v=>m.specialties.includes(skillMap[v]));const areaMatch=p.area&&m.specialties.includes(p.area)?1:0;
 const score=goalMatches.length*3+shared.length*2+skillMatches.length+areaMatch*3;
 const reasons=[areaMatch&&`Área de atuação em comum: ${p.area} (+3)`,goalMatches.length&&`Objetivo e especialidades: ${goalMatches.join(', ')} (+${goalMatches.length*3})`,shared.length&&`Interesses em comum: ${shared.join(', ')} (+${shared.length*2})`,skillMatches.length&&`Habilidades relacionadas: ${skillMatches.join(', ')} (+${skillMatches.length})`].filter((v):v is string=>typeof v==='string');return {score,reasons};
}
const compareIds=(a:string,b:string)=>BigInt(a)<BigInt(b)?-1:BigInt(a)>BigInt(b)?1:0;
export async function adminOverview(){
 const people=await getDb().select().from(participants);const allMentors=await getDb().select().from(mentors);
 const counts=new Map(await Promise.all(allMentors.map(async m=>[m.id,await approvedCount(m.id)] as const)));
 const suggestions=await Promise.all(people.map(async p=>{const reviews=await getDb().select().from(matches).where(eq(matches.participantId,p.id));const approved=reviews.find(v=>v.status==='approved'&&v.origin==='legacy');
 const choices=allMentors.filter(m=>m.active&&(counts.get(m.id)||0)<m.capacity&&!reviews.some(r=>r.status==='rejected'&&r.mentorId===m.id)).map(m=>({mentorId:String(m.id),mentorEmail:m.demo?m.demoName||'Mentora fictícia':m.email,demo:m.demo,capacity:m.capacity,occupied:counts.get(m.id)||0,...ranking(p,m)})).filter(v=>v.score>0).sort((a,b)=>b.score-a.score||compareIds(a.mentorId,b.mentorId));
 return {id:String(p.id),protocol:`TW-${String(p.id).padStart(5,'0')}`,email:p.email,area:p.area,goal:p.goal,moment:p.moment,interests:p.interests,approvedMentorId:approved?String(approved.mentorId):null,choices};}));
 return {participants:suggestions,mentors:allMentors.map(m=>({id:String(m.id),email:m.demo?m.demoName||'Mentora fictícia':m.email,demo:m.demo,trajectory:m.trajectory,specialties:m.specialties,availability:m.availability,capacity:m.capacity,occupied:counts.get(m.id)||0,active:m.active}))};
}
async function participantForToken(token:string,store:Store=getDb()){
 if(!/^[a-f0-9]{64}$/.test(token))throw new Invalid('Link inválido.',404);const [p]=await store.select().from(participants).where(and(eq(participants.tokenHash,tokenDigest(token)),sql`${participants.legacyAccessRevokedAt} is null`));if(!p)throw new Invalid('Link inválido.',404);return p;
}
export async function publicSuggestions(token:string){
 const p=await participantForToken(token);if((await getDb().select().from(matches).where(approvedCondition(p.id))).length)return {choices:[],assigned:true};
 const all=await getDb().select().from(mentors);const choices=(await Promise.all(all.map(async m=>({...m,occupied:await approvedCount(m.id)})))).filter(m=>m.active&&m.occupied<m.capacity).map(m=>({mentorId:String(m.id),mentorEmail:m.demo?m.demoName||'Mentora fictícia':m.email,demo:m.demo,trajectory:m.trajectory,specialties:m.specialties,capacity:m.capacity,occupied:m.occupied,...ranking(p,m)})).filter(m=>m.score>0).sort((a,b)=>b.score-a.score||compareIds(a.mentorId,b.mentorId)).slice(0,3);return {choices,assigned:false};
}
// Compatibilidade local temporária; WP-003 substituirá por reserva de turma autenticada.
async function lockLegacy(tx:Store){await tx.execute(sql`select pg_advisory_xact_lock(741002)`);}
export async function decide(participantId:string|number,mentorId:string|number,action:string){
 const pid=legacyId(participantId),mid=legacyId(mentorId);if(!['approve','reject'].includes(action))throw new Invalid('Decisão inválida.');
 return getDb().transaction(async tx=>{await lockLegacy(tx);const [p]=await tx.select().from(participants).where(eq(participants.id,pid));const [m]=await tx.select().from(mentors).where(eq(mentors.id,mid));if(!p||!m||!m.active)throw new Invalid('Inscrição ou mentora indisponível.',404);
 if((await tx.select().from(matches).where(approvedCondition(pid))).length)throw new Invalid('Esta participante já tem um par aprovado.',409);
 if((await tx.select().from(matches).where(and(eq(matches.participantId,pid),eq(matches.mentorId,mid)))).length)throw new Invalid('Esta sugestão já foi revisada.',409);
 if(await approvedCount(mid,tx)>=m.capacity)throw new Invalid('Sem vaga: capacidade atingida.',409);const {score,reasons}=ranking(p,m);if(!score)throw new Invalid('Não há compatibilidade positiva.',409);
 await tx.insert(matches).values({participantId:pid,mentorId:mid,score,reasons,status:action==='approve'?'approved':'rejected',origin:'legacy'});return {status:action==='approve'?'Par aprovado':'Sugestão rejeitada'};});
}
export async function reserve(token:string,mentorId:string|number){
 const mid=legacyId(mentorId);return getDb().transaction(async tx=>{await lockLegacy(tx);const p=await participantForToken(token,tx);
 if((await tx.select().from(matches).where(approvedCondition(p.id))).length)throw new Invalid('Você já escolheu uma mentora.',409);const [m]=await tx.select().from(mentors).where(eq(mentors.id,mid));
 if(!m||!m.active||await approvedCount(mid,tx)>=m.capacity)throw new Invalid('Esta vaga não está mais disponível. Atualize as opções.',409);const {score,reasons}=ranking(p,m);if(!score)throw new Invalid('Não há compatibilidade positiva.',409);
 await tx.insert(matches).values({participantId:p.id,mentorId:mid,score,reasons,status:'approved',origin:'legacy'});return {protocol:`TW-${String(p.id).padStart(5,'0')}`,mentorEmail:m.demo?m.demoName||'Mentora fictícia (demonstração)':m.email,participantEmail:p.email,participantId:String(p.id)};});
}
export async function adminChange(participantId:string|number,mentorId:string|number|null,action:'cancel'|'reassign'){
 const pid=legacyId(participantId),mid=mentorId===null?null:legacyId(mentorId);return getDb().transaction(async tx=>{await lockLegacy(tx);
 const [p]=await tx.select().from(participants).where(eq(participants.id,pid));if(!p)throw new Invalid('Inscrição inexistente.',404);const [previous]=await tx.select().from(matches).where(approvedCondition(pid));
 if(action==='cancel'&&!previous)throw new Invalid('Não há par para cancelar.',409);if(action==='reassign'&&previous?.mentorId===mid)throw new Invalid('Esta mentora já está atribuída.',409);
 let m:Mentor|undefined;if(action==='reassign'){if(!mid)throw new Invalid('Mentora inválida.');[m]=await tx.select().from(mentors).where(eq(mentors.id,mid));if(!m||!m.active||await approvedCount(m.id,tx)>=m.capacity)throw new Invalid('Mentora sem vaga disponível.',409);if(!ranking(p,m).score)throw new Invalid('Não há compatibilidade positiva.',409);}
 await tx.update(matches).set({status:'rejected'}).where(approvedCondition(pid));if(m){const {score,reasons}=ranking(p,m);await tx.insert(matches).values({participantId:pid,mentorId:m.id,score,reasons,status:'approved',origin:'legacy'});}return {status:action==='cancel'?'Reserva cancelada':'Mentora realocada'};});
}
export async function setMentorActive(id:string|number,active:boolean){const rows=await getDb().update(mentors).set({active}).where(eq(mentors.id,legacyId(id))).returning({id:mentors.id});if(!rows.length)throw new Invalid('Mentora inexistente.',404);return {status:active?'Mentora ativada':'Mentora desativada'};}
export async function removeDemoMentors(){const rows=await getDb().update(mentors).set({active:false}).where(and(eq(mentors.demo,true),eq(mentors.active,true))).returning({id:mentors.id});return {status:`${rows.length} mentoras de demonstração desativadas.`};}
export async function adminForEmail(email:string){const rows=await getDb().select({email:users.email,role:userRoles.role}).from(users).innerJoin(userRoles,eq(userRoles.userId,users.id)).where(and(eq(users.emailKey,email.trim().toLowerCase()),eq(users.status,'active'),sql`${userRoles.role} in ('admin','team')`));const row=rows.find(r=>r.role==='admin')||rows[0];return row?{email:row.email,role:row.role==='admin'?'owner':'member'}:null;}
export async function authenticate(email:string,password:string){const [user]=await getDb().select().from(users).where(eq(users.emailKey,email.trim().toLowerCase()));if(!user||user.status!=='active'||user.mustChangePassword||!user.passwordHash||!await verifyPassword(password,user.passwordHash))return null;return adminForEmail(email);}
