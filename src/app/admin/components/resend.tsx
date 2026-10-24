'use client';
import { useEffect, useRef, useState } from 'react';
import type { UserDto } from '@/lib/contracts';
import { request } from '../../shared';
import { NOT_FOUND_MESSAGE, failureMessage, useIdempotency, type AuthHandler, type Loaded } from './records';
/** O segredo pertence ao worker. A interface só confirma uma intenção idempotente e ignora jobId. */
export function ResendDialog({ loaded, onClose, onQueued, onAuthError }: { loaded: Loaded<UserDto>; onClose: () => void; onQueued: () => void; onAuthError: AuthHandler }) {
 const dialog = useRef<HTMLDialogElement>(null), inFlight = useRef(false);
 const [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(false), [missing, setMissing] = useState(false);
 const keyFor = useIdempotency();
 useEffect(() => { const el = dialog.current; el?.showModal(); return () => { el?.close(); }; }, []);
 async function confirm() {
  if (inFlight.current) return;
  inFlight.current = true; setBusy(true); setError('');
  const body = { confirm: true };
  const result = await request<unknown>(`/api/v1/admin/users/${loaded.item.id}/temporary-password`, { method: 'POST', body, idempotencyKey: keyFor(body) });
  inFlight.current = false; setBusy(false);
  if (result.ok && result.status === 202) { onQueued(); return; }
  if (!result.ok) {
   if (onAuthError(result.code)) return;
   setMissing(result.code === 'NOT_FOUND'); setError(failureMessage(result));
   setRetry(result.code === 'NETWORK' || result.code === 'DEPENDENCY_UNAVAILABLE' || result.code === 'RETRY_TRANSACTION' || result.code === 'UNEXPECTED');
  } else setError('Não foi possível confirmar a solicitação. Tente novamente.');
 }
 return <dialog ref={dialog} className="form-panel admin-resend" aria-labelledby="resend-title" aria-describedby="resend-warning" onCancel={e => { e.preventDefault(); if (!inFlight.current) onClose(); }}>
  <p className="eyebrow">ACESSO / CONFIRMAÇÃO</p><h2 id="resend-title">Reenviar acesso temporário</h2>
  {missing ? <p role="alert" className="visible-error">{NOT_FOUND_MESSAGE}</p> : <><p>{loaded.item.email}</p><p id="resend-warning" className="auth-note">Quando a nova emissão ocorrer, acesso anterior/sessões serão invalidados. Use apenas a mensagem mais recente. A solicitação na fila não comprova envio nem entrega.</p>{error && <p role="alert" className="visible-error">{error}</p>}</>}
  <div className="admin-actions"><button type="button" className="button-quiet" autoFocus onClick={onClose} disabled={busy}>Cancelar</button>{!missing && <button type="button" className="button-primary" onClick={() => void confirm()} disabled={busy}>{busy ? 'Solicitando…' : retry ? 'Tentar solicitar novamente' : 'Confirmar reenvio'}</button>}</div>
 </dialog>;
}
