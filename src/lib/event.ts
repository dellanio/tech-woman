import { sqlite } from './db';

export type EventContent = { description:string; venue:string; agenda:string; speakers:string; date:string; duration:string };
const fields = ['description','venue','agenda','speakers','date','duration'] as const;
const initial: EventContent = { description:'Um encontro presencial para compartilhar trajetórias, criar conexões e descobrir caminhos possíveis na tecnologia.',venue:'',agenda:'',speakers:'',date:'2026-11-14',duration:'' };
sqlite.exec('CREATE TABLE IF NOT EXISTS event_content (id INTEGER PRIMARY KEY CHECK(id=1), description TEXT NOT NULL, venue TEXT NOT NULL, agenda TEXT NOT NULL, speakers TEXT NOT NULL, date TEXT NOT NULL, duration TEXT NOT NULL)');
sqlite.prepare('INSERT OR IGNORE INTO event_content(id,description,venue,agenda,speakers,date,duration) VALUES(1,@description,@venue,@agenda,@speakers,@date,@duration)').run(initial);
export function getEvent():EventContent {
  return sqlite.prepare('SELECT description,venue,agenda,speakers,date,duration FROM event_content WHERE id=1').get() as EventContent;
}
export function saveEvent(value:unknown):EventContent {
  if (!value || typeof value!=='object') throw new Error('Conteúdo inválido.');
  const record=value as Record<string,unknown>;
  const entry=Object.fromEntries(fields.map(field=>[field,record[field]]));
  if (fields.some(field=>typeof entry[field]!=='string'||(entry[field] as string).trim().length>1500)) throw new Error('Confira os campos do evento (máximo 1500 caracteres).');
  const date=entry.date as string;
  if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T12:00:00Z`)) || new Date(`${date}T12:00:00Z`).toISOString().slice(0,10)!==date)) throw new Error('Data inválida.');
  const clean=Object.fromEntries(fields.map(field=>[field,(entry[field] as string).trim()])) as EventContent;
  sqlite.prepare('UPDATE event_content SET description=@description,venue=@venue,agenda=@agenda,speakers=@speakers,date=@date,duration=@duration WHERE id=1').run(clean);
  return getEvent();
}
export function eventDate(value:string) { return value ? new Intl.DateTimeFormat('pt-BR',{timeZone:'UTC',day:'numeric',month:'long',year:'numeric'}).format(new Date(`${value}T12:00:00Z`)) : ''; }
