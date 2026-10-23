import { getDb, eventContent } from './db';
import { eq } from 'drizzle-orm';

export type EventContent = { description:string; venue:string; agenda:string; speakers:string; date:string; duration:string };
const fields = ['description','venue','agenda','speakers','date','duration'] as const;
const initial: EventContent = { description:'Um encontro presencial para compartilhar trajetórias, criar conexões e descobrir caminhos possíveis na tecnologia.',venue:'',agenda:'',speakers:'',date:'2026-11-14',duration:'' };
export async function getEvent():Promise<EventContent> {
 const [entry]=await getDb().select({description:eventContent.description,venue:eventContent.venue,agenda:eventContent.agenda,speakers:eventContent.speakers,date:eventContent.date,duration:eventContent.duration}).from(eventContent).where(eq(eventContent.id,1));return entry||initial;
}
export async function saveEvent(value:unknown):Promise<EventContent> {
  if (!value || typeof value!=='object') throw new Error('Conteúdo inválido.');
  const record=value as Record<string,unknown>;
  const entry=Object.fromEntries(fields.map(field=>[field,record[field]]));
  if (fields.some(field=>typeof entry[field]!=='string'||(entry[field] as string).trim().length>1500)) throw new Error('Confira os campos do evento (máximo 1500 caracteres).');
  const date=entry.date as string;
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0,10)!==date)) throw new Error('Data inválida.');
  const clean=Object.fromEntries(fields.map(field=>[field,(entry[field] as string).trim()])) as EventContent;
  await getDb().insert(eventContent).values({id:1,...clean}).onConflictDoUpdate({target:eventContent.id,set:clean});
  return getEvent();
}
export function eventDate(value:string) { return value ? new Intl.DateTimeFormat('pt-BR',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(new Date(`${value}T12:00:00Z`)) : ''; }