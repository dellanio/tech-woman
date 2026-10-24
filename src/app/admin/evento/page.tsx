'use client';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import Link from 'next/link';
import { Frame, errorMessage, request, type ApiErrorCode, type ApiFailure } from '../../shared';
import { StaffGate, useStaffSession } from '../components/staff-gate';
import type { AuthHandler } from '../components/records';
type EventContent = { description: string; venue: string; agenda: string; speakers: string; date: string; duration: string };
const fields: { key: keyof EventContent; label: string; hint: string }[] = [
 { key: 'description', label: 'Texto do encontro', hint: 'Descrição pública do evento.' },
 { key: 'venue', label: 'Local', hint: 'Vazio = local não publicado.' },
 { key: 'agenda', label: 'Programação do evento (texto)', hint: 'Texto editorial; não cadastra temas ou turmas. Vazio = programação não publicada.' },
 { key: 'speakers', label: 'Palestrantes', hint: 'Vazio = palestrantes não publicados.' },
 { key: 'date', label: 'Data', hint: 'Data civil do evento. Vazio = data a definir.' },
 { key: 'duration', label: 'Duração', hint: 'Vazio = duração não publicada.' },
];
const fail = (code: ApiErrorCode, status = 0): ApiFailure => ({ ok: false, code, status, message: errorMessage(code), fields: [] });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Este endpoint legado retorna o conteúdo sem envelope. CSRF continua vindo do contrato v1. */
async function eventRequest(content?: EventContent): Promise<{ ok: true; content: EventContent } | ApiFailure> {
 const headers = new Headers({ Accept: 'application/json' });
 if (content) {
  const csrf = await request<{ csrfToken: string }>('/api/v1/auth/csrf');
  if (!csrf.ok) return csrf;
  if (typeof csrf.data.csrfToken !== 'string') return fail('UNEXPECTED');
  headers.set('X-CSRF-Token', csrf.data.csrfToken); headers.set('Content-Type', 'application/json');
 }
 let response: Response;
 try { response = await fetch('/api/admin/event', { method: content ? 'PUT' : 'GET', headers, credentials: 'same-origin', cache: 'no-store', ...(content ? { body: JSON.stringify(content) } : {}) }); }
 catch { return fail('NETWORK'); }
 let body: unknown;
 try { body = await response.json(); } catch { return fail('UNEXPECTED', response.status); }
 if (!response.ok) {
  const code = object(body) && object(body.error) ? body.error.code : null;
  if (code === 'AUTH_REQUIRED' || code === 'PASSWORD_CHANGE_REQUIRED' || code === 'FORBIDDEN' || code === 'CSRF_REJECTED' || code === 'DEPENDENCY_UNAVAILABLE' || code === 'MAINTENANCE' || code === 'INVALID_INPUT') return fail(code, response.status);
  return fail(response.status === 401 ? 'AUTH_REQUIRED' : response.status === 503 ? 'DEPENDENCY_UNAVAILABLE' : 'UNEXPECTED', response.status);
 }
 if (!object(body) || !fields.every(f => typeof body[f.key] === 'string')) return fail('UNEXPECTED', response.status);
 return { ok: true, content: Object.fromEntries(fields.map(f => [f.key, body[f.key]])) as EventContent };
}
export default function EventEditor() {
 const { view, retry, onAuthError } = useStaffSession('/admin/evento');
 return <Frame eyebrow="EQUIPE / CONTEÚDO"><StaffGate view={view} retry={() => void retry()}>{({ canWrite }) => <ContentEditor canWrite={canWrite} onAuthError={onAuthError}/>}</StaffGate></Frame>;
}
function ContentEditor({ canWrite, onAuthError }: { canWrite: boolean; onAuthError: AuthHandler }) {
 const [content, setContent] = useState<EventContent | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [retrySave, setRetrySave] = useState(false);
 const generation = useRef(0), inFlight = useRef(false);
 const load = useCallback(async () => {
  const mine = ++generation.current; setLoading(true); setError('');
  const result = await eventRequest();
  if (mine !== generation.current) return;
  setLoading(false);
  if (result.ok) setContent(result.content);
  else if (!onAuthError(result.code)) setError(result.message);
 }, [onAuthError]);
 useEffect(() => { void load(); return () => { generation.current++; }; }, [load]);
 async function submit(event: FormEvent) {
  event.preventDefault(); if (!canWrite || !content || inFlight.current) return;
  inFlight.current = true; setBusy(true); setError(''); setNotice('');
  const result = await eventRequest(content);
  inFlight.current = false; setBusy(false);
  if (result.ok) { setContent(result.content); setRetrySave(false); setNotice('Alterações salvas. A página pública mostra o conteúdo confirmado.'); }
  else if (!onAuthError(result.code)) { setError(result.message); setRetrySave(true); }
 }
 return <>
  <section className="editor-intro"><p className="eyebrow">PUBLICAÇÃO / EVENTO</p><h1>O encontro, <em>em suas palavras.</em></h1><p>Campos vazios não são publicados. Este editor mantém o conteúdo textual do encontro.</p><Link className="text-link" href="/admin">← Voltar ao painel</Link></section>
  {!canWrite && <p className="notice" role="note">Acesso de equipe: conteúdo somente leitura. Só a administração pode salvar alterações.</p>}
  {loading && <p role="status" className="auth-loading" aria-busy="true">Carregando conteúdo do evento…</p>}
  {error && <div><p role="alert" className="visible-error">{error}</p>{!content && <button type="button" className="button-secondary" onClick={() => void load()}>Tentar novamente</button>}</div>}
  {notice && <p role="status" className="notice">{notice}</p>}
  {content && !loading && <form className="form-panel event-editor" aria-label="Conteúdo do evento" onSubmit={submit} aria-busy={busy}>
   {fields.map(({ key, label, hint }) => <div key={key}><label className="field-label" htmlFor={`event-${key}`}>{label}</label><p className="field-hint" id={`event-${key}-hint`}>{hint}</p>{key === 'description' || key === 'agenda' || key === 'speakers' ? <textarea id={`event-${key}`} aria-describedby={`event-${key}-hint`} maxLength={1500} value={content[key]} readOnly={!canWrite} onChange={e => setContent({ ...content, [key]: e.target.value })}/> : <input id={`event-${key}`} aria-describedby={`event-${key}-hint`} type={key === 'date' ? 'date' : 'text'} maxLength={1500} value={content[key]} readOnly={!canWrite} onChange={e => setContent({ ...content, [key]: e.target.value })}/>}</div>)}
   {canWrite && <button className="button-primary form-main-action" disabled={busy}>{busy ? 'Salvando…' : retrySave ? 'Tentar salvar novamente' : 'Salvar alterações ↗'}</button>}
  </form>}
 </>;
}
