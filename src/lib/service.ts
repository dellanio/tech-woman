import { db, sqlite, participants, mentors, tokenDigest, newToken, type Participant, type Mentor, verifyPassword } from './db';
import { eq } from 'drizzle-orm';
import { confirmRegistration, emailLabel } from './email';

const tags = ['produto','dados','desenvolvimento','design'] as const;
export const areas = [...tags, 'outra'] as const;
export const mentorDeadline = process.env.MENTOR_DEADLINE || '2026-11-01T02:59:59.999Z';
export const mentorRegistrationOpen = () => !Number.isNaN(Date.parse(mentorDeadline)) && Date.now() <= Date.parse(mentorDeadline);
type Tag = typeof tags[number];
type Input = Record<string, unknown>;
export const goals = ['transition','growth','leadership'] as const;
export const moments = ['starting','working','returning'] as const;
const isText = (value: unknown, max = 400) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max;
const emailValid = (value: unknown) => typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const list = (value: unknown): value is Tag[] => Array.isArray(value) && value.length > 0 && value.length <= 3 && new Set(value).size === value.length && value.every(v => tags.includes(v));
const skills = ['comunicacao','analise','codigo','gestao'];
const skillList = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= 4 && new Set(value).size === value.length && value.every(v => skills.includes(v));
export class Invalid extends Error { constructor(message: string, public status = 400) { super(message); } }
export async function createParticipant(input: Input) {
  if (!emailValid(input.email) || !goals.includes(input.goal as typeof goals[number]) || !moments.includes(input.moment as typeof moments[number]) || !list(input.interests) || !skillList(input.skills) || !areas.includes(input.area as typeof areas[number]) || (input.area === 'outra' && !isText(input.otherArea,80)) || input.consent !== true) throw new Invalid('Confira os campos, área de atuação e consentimento para continuar.');
  const token = newToken();
  const email = String(input.email).trim().toLowerCase();
  const participantId = sqlite.transaction(() => {
    const entry = db.insert(participants).values({ email, goal: String(input.goal), moment: String(input.moment), interests: JSON.stringify(input.interests), skills: JSON.stringify(input.skills), area: input.area === 'outra' ? `outra: ${String(input.otherArea).trim()}` : String(input.area), tokenHash: tokenDigest(token), consentVersion: 'v1', consentAt: new Date().toISOString() }).run();
    sqlite.prepare('INSERT INTO email_attempt(participant_id,status,updated_at) VALUES(?,?,?)').run(entry.lastInsertRowid, 'mock-not-sent', new Date().toISOString());
    return Number(entry.lastInsertRowid);
  })();
  const protocol = `TW-${String(participantId).padStart(5,'0')}`;
  const emailStatus = await confirmRegistration(participantId, email, protocol);
  return { protocol, token, emailStatus };
}
export function createMentor(input: Input) {
  if (!mentorRegistrationOpen()) throw new Invalid('Cadastro de mentoras encerrado.', 403);
  if (!emailValid(input.email) || !isText(input.trajectory, 1000) || !list(input.specialties) || !isText(input.availability, 300) || !Number.isInteger(input.capacity) || Number(input.capacity) < 1 || Number(input.capacity) > 50 || input.consent !== true) throw new Invalid('Preencha trajetória, especialidades, disponibilidade, capacidade e consentimento.');
  const entry = db.insert(mentors).values({ email: String(input.email).trim().toLowerCase(), trajectory: String(input.trajectory).trim(), specialties: JSON.stringify(input.specialties), availability: String(input.availability).trim(), capacity: Number(input.capacity), active: 1 }).run();
  return { protocol: `M-${String(entry.lastInsertRowid).padStart(5,'0')}` };
}
export function stateFor(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const participant = db.select().from(participants).where(eq(participants.tokenHash, tokenDigest(token))).get();
  if (!participant) return null;
  const approved = sqlite.prepare("SELECT m.email,m.trajectory,x.reasons FROM match x JOIN mentor m ON m.id=x.mentor_id WHERE x.participant_id=? AND x.status='approved'").get(participant.id) as { email:string; trajectory:string; reasons:string } | undefined;
  const attempt = sqlite.prepare('SELECT status FROM email_attempt WHERE participant_id=?').get(participant.id) as {status:string} | undefined;
  const choiceAttempt = sqlite.prepare('SELECT status FROM choice_email_attempt WHERE participant_id=?').get(participant.id) as {status:string}|undefined;
  return { protocol: `TW-${String(participant.id).padStart(5,'0')}`, email: participant.email, status: approved ? 'Mentoria reservada' : 'Aguardando escolha ou revisão da equipe', emailStatus: emailLabel(attempt?.status || 'unavailable-not-sent'), choiceEmailStatus: approved && choiceAttempt ? emailLabel(choiceAttempt.status) : null, mentor: approved ? { email: approved.email, trajectory: approved.trajectory, reasons: JSON.parse(approved.reasons) as string[] } : null };
}
const approvedCount = (mentorId: number) => (sqlite.prepare("SELECT COUNT(*) AS count FROM match WHERE mentor_id=? AND status='approved'").get(mentorId) as { count:number }).count;
function ranking(participant: Participant, mentor: Mentor) {
  const specialty: string[] = JSON.parse(mentor.specialties);
  const interests: string[] = JSON.parse(participant.interests);
  const abilities: string[] = JSON.parse(participant.skills);
  const objectives: Record<string,string[]> = { transition: ['desenvolvimento','design','produto','dados'], growth: ['produto','dados'], leadership: ['produto','design'] };
  const goalMatches = specialty.filter(v => (objectives[participant.goal] || []).includes(v) && interests.includes(v));
  const shared = specialty.filter(v => interests.includes(v));
  const skillMap: Record<string,string> = { codigo:'desenvolvimento', analise:'dados', comunicacao:'produto', gestao:'design' };
  const skillMatches = abilities.filter(v => specialty.includes(skillMap[v]));
  const areaMatch = participant.area && specialty.includes(participant.area) ? 1 : 0;
  const score = goalMatches.length * 3 + shared.length * 2 + skillMatches.length + areaMatch * 3;
  const reasons = [areaMatch && `Área de atuação em comum: ${participant.area} (+3)`, goalMatches.length && `Objetivo e especialidades: ${goalMatches.join(', ')} (+${goalMatches.length * 3})`, shared.length && `Interesses em comum: ${shared.join(', ')} (+${shared.length * 2})`, skillMatches.length && `Habilidades relacionadas: ${skillMatches.join(', ')} (+${skillMatches.length})`].filter((v): v is string => typeof v === 'string');
  return { score, reasons };
}
export function adminOverview() {
  const people = db.select().from(participants).all();
  const allMentors = db.select().from(mentors).all();
  const suggestions = people.map(p => {
    const approved = sqlite.prepare("SELECT mentor_id FROM match WHERE participant_id=? AND status='approved'").get(p.id) as { mentor_id:number } | undefined;
    const rejected = sqlite.prepare("SELECT mentor_id FROM match WHERE participant_id=? AND status='rejected'").all(p.id) as { mentor_id:number }[];
    const choices = allMentors.filter(m => m.active && approvedCount(m.id) < m.capacity && !rejected.some(r => r.mentor_id === m.id)).map(m => ({ mentorId:m.id, mentorEmail:m.email, capacity:m.capacity, occupied:approvedCount(m.id), ...ranking(p,m) })).filter(v => v.score > 0).sort((a,b) => b.score-a.score || a.mentorId-b.mentorId);
    return { id:p.id, protocol:`TW-${String(p.id).padStart(5,'0')}`, email:p.email, area:p.area, goal:p.goal, moment:p.moment, interests:JSON.parse(p.interests) as string[], approvedMentorId:approved?.mentor_id || null, choices };
  });
  return { participants:suggestions, mentors:allMentors.map(m => ({id:m.id,email:m.email,trajectory:m.trajectory,specialties:JSON.parse(m.specialties) as string[],availability:m.availability,capacity:m.capacity,occupied:approvedCount(m.id),active:!!m.active})) };
}
export function decide(participantId: number, mentorId: number, action: string) {
  if (!Number.isInteger(participantId) || !Number.isInteger(mentorId) || !['approve','reject'].includes(action)) throw new Invalid('Decisão inválida.');
  return sqlite.transaction(() => {
    const p = db.select().from(participants).where(eq(participants.id, participantId)).get();
    const m = db.select().from(mentors).where(eq(mentors.id, mentorId)).get();
    if (!p || !m || !m.active) throw new Invalid('Inscrição ou mentora indisponível.',404);
    const existing = sqlite.prepare("SELECT id FROM match WHERE participant_id=? AND status='approved'").get(participantId);
    if (existing) throw new Invalid('Esta participante já tem um par aprovado.',409);
    const rejected = sqlite.prepare('SELECT id FROM match WHERE participant_id=? AND mentor_id=?').get(participantId,mentorId);
    if (rejected) throw new Invalid('Esta sugestão já foi revisada.',409);
    if (approvedCount(mentorId) >= m.capacity) throw new Invalid('Sem vaga: capacidade atingida.',409);
    const { score, reasons } = ranking(p,m);
    if (!score) throw new Invalid('Não há compatibilidade positiva.',409);
    sqlite.prepare('INSERT INTO match(participant_id,mentor_id,score,reasons,status) VALUES(?,?,?,?,?)').run(participantId,mentorId,score,JSON.stringify(reasons),action === 'approve' ? 'approved' : 'rejected');
    return { status: action === 'approve' ? 'Par aprovado' : 'Sugestão rejeitada' };
  }).immediate();
}
function participantForToken(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Invalid('Link inválido.',404);
  const p = db.select().from(participants).where(eq(participants.tokenHash,tokenDigest(token))).get();
  if (!p) throw new Invalid('Link inválido.',404);
  return p;
}
export function publicSuggestions(token: string) {
  const p = participantForToken(token);
  const existing = sqlite.prepare("SELECT id FROM match WHERE participant_id=? AND status='approved'").get(p.id);
  if (existing) return {choices:[],assigned:true};
  const choices = db.select().from(mentors).all().filter(m => m.active && approvedCount(m.id)<m.capacity)
    .map(m => ({mentorId:m.id,mentorEmail:m.email,trajectory:m.trajectory,specialties:JSON.parse(m.specialties) as string[],capacity:m.capacity,occupied:approvedCount(m.id),...ranking(p,m)}))
    .filter(m => m.score>0).sort((a,b)=>b.score-a.score || a.mentorId-b.mentorId).slice(0,3);
  return {choices,assigned:false};
}
export function reserve(token: string, mentorId: number) {
  const p = participantForToken(token);
  if (!Number.isInteger(mentorId)) throw new Invalid('Mentora inválida.');
  return sqlite.transaction(() => {
    if (sqlite.prepare("SELECT id FROM match WHERE participant_id=? AND status='approved'").get(p.id)) throw new Invalid('Você já escolheu uma mentora.',409);
    const m = db.select().from(mentors).where(eq(mentors.id,mentorId)).get();
    if (!m || !m.active || approvedCount(mentorId)>=m.capacity) throw new Invalid('Esta vaga não está mais disponível. Atualize as opções.',409);
    const {score,reasons}=ranking(p,m);
    if (!score) throw new Invalid('Não há compatibilidade positiva.',409);
    sqlite.prepare('INSERT INTO match(participant_id,mentor_id,score,reasons,status) VALUES(?,?,?,?,?)').run(p.id,mentorId,score,JSON.stringify(reasons),'approved');
    return {protocol:`TW-${String(p.id).padStart(5,'0')}`,mentorEmail:m.email,participantEmail:p.email,participantId:p.id};
  }).immediate();
}
export function adminChange(participantId:number, mentorId:number|null, action:'cancel'|'reassign') {
  if (!Number.isInteger(participantId) || (action==='reassign' && !Number.isInteger(mentorId))) throw new Invalid('Decisão inválida.');
  return sqlite.transaction(() => {
    const p=db.select().from(participants).where(eq(participants.id,participantId)).get();
    if (!p) throw new Invalid('Inscrição inexistente.',404);
    const previous=sqlite.prepare("SELECT mentor_id FROM match WHERE participant_id=? AND status='approved'").get(participantId) as {mentor_id:number}|undefined;
    if (action==='cancel' && !previous) throw new Invalid('Não há par para cancelar.',409);
    if (action==='reassign' && previous?.mentor_id===mentorId) throw new Invalid('Esta mentora já está atribuída.',409);
    let newMentor:Mentor|undefined;
    if (action==='reassign') {
      newMentor=db.select().from(mentors).where(eq(mentors.id,mentorId!)).get();
      if (!newMentor || !newMentor.active || approvedCount(newMentor.id)>=newMentor.capacity) throw new Invalid('Mentora sem vaga disponível.',409);
      if (!ranking(p,newMentor).score) throw new Invalid('Não há compatibilidade positiva.',409);
    }
    sqlite.prepare("UPDATE match SET status='rejected' WHERE participant_id=? AND status='approved'").run(participantId);
    if (newMentor) {
      const {score,reasons}=ranking(p,newMentor);
      sqlite.prepare('INSERT INTO match(participant_id,mentor_id,score,reasons,status) VALUES(?,?,?,?,?)').run(participantId,newMentor.id,score,JSON.stringify(reasons),'approved');
    }
    return {status:action==='cancel'?'Reserva cancelada':'Mentora realocada'};
  }).immediate();
}
export function setMentorActive(id:number, active:boolean) {
  if (!Number.isInteger(id)) throw new Invalid('Mentora inválida.');
  const result=sqlite.prepare('UPDATE mentor SET active=? WHERE id=?').run(active?1:0,id);
  if (!result.changes) throw new Invalid('Mentora inexistente.',404);
  return {status:active?'Mentora ativada':'Mentora desativada'};
}
export function authenticate(email: string, password: string) {
  const user = sqlite.prepare('SELECT email,password_hash,role FROM admin_user WHERE email=?').get(email) as {email:string;password_hash:string;role:string} | undefined;
  return user && verifyPassword(password,user.password_hash) ? {email:user.email,role:user.role} : null;
}
