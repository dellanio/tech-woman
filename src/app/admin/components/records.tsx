'use client';
/** Peças comuns dos CRUDs: leitura individual (ETag) antes de editar/desativar, conflito 412 que preserva o rascunho, erro de rede com nova tentativa, 404 indistinto e criação com Idempotency-Key estável. */
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { newIdempotencyKey, request, type ApiErrorCode, type ApiFailure } from '../../shared';
import { focusField, type Issue } from '../../diagnostic';

export const NOT_FOUND_MESSAGE = 'Não encontramos este registro. Ele pode ter sido removido ou não estar disponível para este painel.';
const RELOAD_FAILED = 'Não foi possível carregar a versão atual agora. Seu rascunho foi mantido; tente novamente.';
export const CONFLICT_MESSAGE = 'Este registro mudou desde que você abriu. Seu rascunho foi mantido; carregue a versão atual para conferir antes de salvar de novo.';
type Versioned = { id: string; version: string };
export type AuthHandler = (code: ApiErrorCode) => boolean;

/** Mensagem de falha comum; `conflicts` personaliza 409 por recurso (ex.: reservas ativas). */
export function failureMessage(failure: ApiFailure, conflicts: Partial<Record<ApiErrorCode, string>> = {}) {
  if (conflicts[failure.code]) return conflicts[failure.code] as string;
  if (failure.code === 'NOT_FOUND') return NOT_FOUND_MESSAGE;
  if (failure.code === 'VERSION_MISMATCH') return CONFLICT_MESSAGE;
  return failure.message;
}

/** Chave estável por tentativa lógica: reenviar o mesmo corpo (rede/indisponível) reusa a chave; corpo diferente → chave nova. */
export function useIdempotency() {
  const ref = useRef<{ key: string; body: string } | null>(null);
  return useCallback((body: unknown) => {
    const text = JSON.stringify(body);
    if (!ref.current || ref.current.body !== text) ref.current = { key: newIdempotencyKey(), body: text };
    return ref.current.key;
  }, []);
}

type FieldIssue<F extends string> = Issue<F>;
/** Formulário de criação: valida no cliente na ordem da tela, envia uma intenção por vez (botão ocupado) e mantém os dados em qualquer falha. */
export function CreateForm<D, F extends string, R>({ title, intro, path, initial, issues, toBody, ids, fields, onCreated, onCancel, onAuthError, conflicts, fieldOf }: {
  title: string; intro: ReactNode; path: string; initial: D;
  issues: (draft: D) => FieldIssue<F>[]; toBody: (draft: D) => unknown; ids: Record<F, string>;
  fields: (draft: D, setDraft: (next: D) => void, invalid: F[]) => ReactNode;
  onCreated: (created: R) => void; onCancel: () => void; onAuthError: AuthHandler;
  conflicts?: Partial<Record<ApiErrorCode, string>>; fieldOf?: (serverField: string) => F | null;
}) {
  const [draft, setDraft] = useState<D>(initial), [invalid, setInvalid] = useState<F[]>([]), [errors, setErrors] = useState<string[]>([]), [busy, setBusy] = useState(false), [retry, setRetry] = useState(false);
  const keyFor = useIdempotency();
  // Duplo clique: o segundo envio é ignorado mesmo antes de o botão ocupado renderizar.
  const inFlight = useRef(false);
  const firstField = ids[Object.keys(ids)[0] as F];
  useEffect(() => { focusField(firstField); }, [firstField]);
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (inFlight.current) return;
    const found = issues(draft);
    setInvalid(found.map(i => i.field)); setErrors(found.map(i => i.message)); setRetry(false);
    if (found.length) { focusField(ids[found[0].field]); return; }
    const body = toBody(draft);
    inFlight.current = true; setBusy(true);
    const result = await request<R>(path, { method: 'POST', body, idempotencyKey: keyFor(body) });
    inFlight.current = false; setBusy(false);
    if (result.ok) { onCreated(result.data); return; }
    if (onAuthError(result.code)) return;
    const mapped = (result.fields.map(f => fieldOf?.(f) ?? null).filter(Boolean) as F[]);
    setInvalid(mapped); setErrors([failureMessage(result, conflicts)]);
    setRetry(result.code === 'NETWORK' || result.code === 'DEPENDENCY_UNAVAILABLE' || result.code === 'RETRY_TRANSACTION' || result.code === 'UNEXPECTED');
    if (mapped.length) focusField(ids[mapped[0]]);
  }
  return <form className="form-panel admin-form" aria-label={title} onSubmit={submit} noValidate aria-busy={busy}>
    <p className="eyebrow">CADASTRO PELA ORGANIZAÇÃO</p><h2>{title}</h2>
    <div className="auth-note">{intro}</div>
    {fields(draft, setDraft, invalid)}
    {errors.length > 0 && <div role="alert" className="visible-error">{errors.length === 1 ? errors[0] : <ul>{errors.map(e => <li key={e}>{e}</li>)}</ul>}</div>}
    <div className="admin-actions">
      <button type="submit" className="button-primary" disabled={busy}>{busy ? 'Salvando…' : retry ? 'Tentar salvar novamente' : 'Salvar cadastro'}</button>
      <button type="button" className="button-quiet" onClick={onCancel} disabled={busy}>Cancelar</button>
    </div>
  </form>;
}

/** Mesma regra do contrato v1 (um @, domínio com ponto, ASCII visível). */
export const validEmail = (value: string) => { const v = value.trim(); return v.length >= 3 && v.length <= 254 && v.split('@').length === 2 && /^[\x21-\x7e]+@[^@\s]+\.[^@\s]+$/.test(v); };
export const EMAIL_MESSAGE = 'Informe um e-mail válido.';

export type Loaded<T> = { item: T; etag: string };
/** Lê o registro por ID (com ETag) — base de toda edição/desativação.
 * `quiet` (releitura pedida dentro do formulário): mantém o formulário montado e só troca o estado em 404, que nunca deixa dados anteriores na tela. */
export function useRecord<T extends Versioned>(path: string, onAuthError: AuthHandler) {
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; loaded: Loaded<T> } | { status: 'error'; message: string; missing: boolean }>({ status: 'loading' });
  const load = useCallback(async (quiet = false): Promise<Loaded<T> | null> => {
    if (!quiet) setState({ status: 'loading' });
    const result = await request<T>(path);
    if (result.ok && result.etag) { const loaded = { item: result.data, etag: result.etag }; setState({ status: 'ready', loaded }); return loaded; }
    if (!result.ok && onAuthError(result.code)) return null;
    const missing = !result.ok && result.code === 'NOT_FOUND';
    if (!quiet || missing) setState({ status: 'error', message: result.ok ? 'Não foi possível concluir. Tente novamente.' : failureMessage(result), missing });
    return null;
  }, [path, onAuthError]);
  useEffect(() => { void load(); }, [load]);
  return { state, load, reloadQuiet: useCallback(() => load(true), [load]) };
}

/** Moldura dos estados da leitura individual: carregando, 404 sem dados anteriores, erro com nova tentativa. */
export function RecordFrame<T extends Versioned>({ state, reload, onClose, label, children }: { state: ReturnType<typeof useRecord<T>>['state']; reload: () => void; onClose: () => void; label: string; children: (loaded: Loaded<T>) => ReactNode }) {
  if (state.status === 'loading') return <div className="form-panel admin-form" aria-busy="true"><p role="status" className="auth-loading">Carregando {label}…</p></div>;
  if (state.status === 'error') return <div className="form-panel admin-form"><p role="alert" className="visible-error">{state.message}</p><div className="admin-actions">{!state.missing && <button type="button" className="button-secondary" onClick={reload}>Tentar novamente</button>}<button type="button" className="button-quiet" onClick={onClose}>Fechar</button></div></div>;
  return <>{children(state.loaded)}</>;
}

/** Edição com If-Match = ETag lido. 412 mantém o rascunho e só troca a versão quando a pessoa pede "Carregar versão atual". */
function MissingRecord({ onClose }: { onClose: () => void }) {
  return <div className="form-panel admin-form"><p role="alert" className="visible-error">{NOT_FOUND_MESSAGE}</p><button type="button" className="button-quiet" onClick={onClose}>Fechar</button></div>;
}

export function EditForm<T extends Versioned, D, F extends string>({ title, path, loaded, reload, toDraft, issues, toPatch, ids, fields, header, onSaved, onClose, onAuthError, conflicts, fieldOf }: {
  title: string; path: string; loaded: Loaded<T>; reload: () => Promise<Loaded<T> | null>;
  toDraft: (item: T) => D; issues: (draft: D) => Issue<F>[]; toPatch: (draft: D, item: T) => unknown; ids: Record<F, string>;
  fields: (draft: D, setDraft: (next: D) => void, invalid: F[]) => ReactNode; header?: ReactNode;
  onSaved: (item: T) => void; onClose: () => void; onAuthError: AuthHandler;
  conflicts?: Partial<Record<ApiErrorCode, string>>; fieldOf?: (serverField: string) => F | null;
}) {
  const [draft, setDraft] = useState<D>(() => toDraft(loaded.item)), [base, setBase] = useState(loaded);
  const [invalid, setInvalid] = useState<F[]>([]), [error, setError] = useState(''), [busy, setBusy] = useState(false), [conflict, setConflict] = useState(false), [retry, setRetry] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null), inFlight = useRef(false);
  const [missing, setMissing] = useState(false);
  useEffect(() => { titleRef.current?.focus(); }, []);
  async function submit(event?: FormEvent) {
    event?.preventDefault();
    if (inFlight.current || conflict || missing) return;
    const found = issues(draft);
    setInvalid(found.map(i => i.field)); setError(found.map(i => i.message).join(' ')); setRetry(false);
    if (found.length) { focusField(ids[found[0].field]); return; }
    inFlight.current = true; setBusy(true);
    const result = await request<T>(path, { method: 'PATCH', body: toPatch(draft, base.item), ifMatch: base.etag });
    inFlight.current = false; setBusy(false);
    if (result.ok) { setConflict(false); setError(''); onSaved(result.data); return; }
    if (onAuthError(result.code)) return;
    if (result.code === 'NOT_FOUND') { setMissing(true); return; }
    setConflict(result.code === 'VERSION_MISMATCH');
    setRetry(result.code === 'NETWORK' || result.code === 'DEPENDENCY_UNAVAILABLE' || result.code === 'RETRY_TRANSACTION' || result.code === 'UNEXPECTED');
    const mapped = result.fields.map(f => fieldOf?.(f) ?? null).filter(Boolean) as F[];
    setInvalid(mapped); setError(failureMessage(result, conflicts));
    if (mapped.length) focusField(ids[mapped[0]]);
  }
  async function loadCurrent() {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true);
    const current = await reload();
    inFlight.current = false; setBusy(false);
    if (!current) { setError(RELOAD_FAILED); return; }
    setBase(current); setDraft(toDraft(current.item)); setConflict(false); setError(''); setInvalid([]);
  }
  if (missing) return <MissingRecord onClose={onClose}/>;
  return <form className="form-panel admin-form" aria-label={title} onSubmit={submit} noValidate aria-busy={busy}>
    <p className="eyebrow">EDIÇÃO · VERSÃO {base.item.version}</p><h2 ref={titleRef} tabIndex={-1}>{title}</h2>
    {header}
    {fields(draft, setDraft, invalid)}
    {error && <div role="alert" className="visible-error">{error}{conflict && <div className="admin-actions"><button type="button" className="button-secondary" onClick={() => void loadCurrent()} disabled={busy}>Carregar versão atual</button></div>}</div>}
    <div className="admin-actions">
      <button type="submit" className="button-primary" disabled={busy || conflict}>{busy ? 'Salvando…' : retry ? 'Tentar salvar novamente' : 'Salvar alterações'}</button>
      <button type="button" className="button-quiet" onClick={onClose} disabled={busy}>Cancelar</button>
    </div>
  </form>;
}

/** Desativação (DELETE soft) depois da leitura individual: confirmação explícita com o efeito no histórico. */
export function DeactivateConfirm<T extends Versioned>({ title, path, loaded, reload, warning, conflicts, confirmLabel = 'Confirmar desativação', method = 'DELETE', onDone, onClose, onAuthError }: {
  title: string; path: string; loaded: Loaded<T>; reload: () => Promise<Loaded<T> | null>; warning: ReactNode;
  conflicts?: Partial<Record<ApiErrorCode, string>>; confirmLabel?: string; method?: 'DELETE';
  onDone: (item: T) => void; onClose: () => void; onAuthError: AuthHandler;
}) {
  const [base, setBase] = useState(loaded), [busy, setBusy] = useState(false), [error, setError] = useState(''), [conflict, setConflict] = useState(false), [blocked, setBlocked] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null), inFlight = useRef(false);
  const [missing, setMissing] = useState(false);
  useEffect(() => { titleRef.current?.focus(); }, []);
  async function confirm() {
    if (inFlight.current || conflict || missing) return;
    inFlight.current = true; setBusy(true); setError('');
    const result = await request<T>(path, { method, ifMatch: base.etag });
    inFlight.current = false; setBusy(false);
    if (result.ok) { onDone(result.data); return; }
    if (onAuthError(result.code)) return;
    if (result.code === 'NOT_FOUND') { setMissing(true); return; }
    setConflict(result.code === 'VERSION_MISMATCH'); setBlocked(result.status === 409 || result.code === 'NOT_FOUND');
    setError(failureMessage(result, conflicts));
  }
  async function loadCurrent() { const current = await reload(); if (!current) { setError(RELOAD_FAILED); return; } setBase(current); setConflict(false); setError(''); }
  if (missing) return <MissingRecord onClose={onClose}/>;
  return <section className="form-panel admin-form admin-confirm" role="alertdialog" aria-labelledby="confirm-title" aria-describedby="confirm-warning">
    <p className="eyebrow">CONFIRMAÇÃO</p><h2 id="confirm-title" ref={titleRef} tabIndex={-1}>{title}</h2>
    <div id="confirm-warning" className="auth-note">{warning}</div>
    {error && <div role="alert" className="visible-error">{error}{conflict && <div className="admin-actions"><button type="button" className="button-secondary" onClick={() => void loadCurrent()}>Carregar versão atual</button></div>}</div>}
    <div className="admin-actions">
      {!blocked && <button type="button" className="button-primary" onClick={() => void confirm()} disabled={busy || conflict}>{busy ? 'Aplicando…' : confirmLabel}</button>}
      <button type="button" className="button-quiet" onClick={onClose} disabled={busy}>Voltar</button>
    </div>
  </section>;
}
