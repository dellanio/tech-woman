'use client';
/** Coleção administrativa paginada por cursor opaco (20 por página): carregando, vazio explicado, erro com nova tentativa e "carregar mais". */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { request, type ApiErrorCode } from '../../shared';

export const PAGE_SIZE = 20;
type Status = 'loading' | 'ready' | 'error';
export type Collection<T> = {
  status: Status; items: T[]; nextCursor: string | null; message: string;
  /** Falha ao carregar a página seguinte: a lista já carregada continua visível. */
  moreStatus: 'idle' | 'loading' | 'error'; moreMessage: string; staleCursor: boolean;
  reload: () => void; loadMore: () => void;
  /** Substitui um item já carregado (após editar/desativar) sem recarregar a lista. */
  replace: (item: T) => void;
};

export function useCollection<T extends { id: string }>(path: string, onAuthError: (code: ApiErrorCode) => boolean): Collection<T> {
  const [status, setStatus] = useState<Status>('loading'), [items, setItems] = useState<T[]>([]), [nextCursor, setNext] = useState<string | null>(null), [message, setMessage] = useState('');
  const [moreStatus, setMoreStatus] = useState<'idle' | 'loading' | 'error'>('idle'), [moreMessage, setMoreMessage] = useState(''), [staleCursor, setStale] = useState(false);
  const generation = useRef(0);
  const reload = useCallback(async () => {
    const mine = ++generation.current;
    setStatus('loading'); setItems([]); setNext(null); setMoreStatus('idle'); setStale(false);
    const result = await request<T[]>(`${path}?limit=${PAGE_SIZE}`);
    if (mine !== generation.current) return;
    if (!result.ok) { if (onAuthError(result.code)) return; setMessage(result.message); setStatus('error'); return; }
    setItems(Array.isArray(result.data) ? result.data : []); setNext(result.nextCursor); setStatus('ready');
  }, [path, onAuthError]);
  const loadMore = useCallback(async () => {
    if (!nextCursor) return;
    const mine = generation.current;
    setMoreStatus('loading');
    const result = await request<T[]>(`${path}?limit=${PAGE_SIZE}&cursor=${encodeURIComponent(nextCursor)}`);
    if (mine !== generation.current) return;
    if (!result.ok) {
      if (onAuthError(result.code)) return;
      // Cursor recusado (lista mudou): só recarregar do início resolve.
      setStale(result.code === 'INVALID_INPUT'); setMoreMessage(result.code === 'INVALID_INPUT' ? 'A lista mudou desde a última leitura. Recarregue para ver a versão atual.' : result.message); setMoreStatus('error'); return;
    }
    const page = Array.isArray(result.data) ? result.data : [];
    setItems(current => [...current, ...page.filter(item => !current.some(c => c.id === item.id))]); setNext(result.nextCursor); setMoreStatus('idle');
  }, [nextCursor, path, onAuthError]);
  const replace = useCallback((item: T) => setItems(current => current.map(c => c.id === item.id ? item : c)), []);
  useEffect(() => { void reload(); }, [reload]);
  return { status, items, nextCursor, message, moreStatus, moreMessage, staleCursor, reload: () => void reload(), loadMore: () => void loadMore(), replace };
}

/** Lista acessível: `label` nomeia a lista e as mensagens; `noun` é o plural usado em "Carregar mais …". */
export function CollectionView<T extends { id: string }>({ collection, label, noun, empty, children }: { collection: Collection<T>; label: string; noun: string; empty: ReactNode; children: (item: T) => ReactNode }) {
  const c = collection;
  if (c.status === 'loading') return <div className="admin-loading" aria-busy="true">
    <p role="status" className="auth-loading">Carregando {noun}…</p>
    <ul className="admin-skeleton" aria-hidden="true">{[0, 1, 2].map(i => <li key={i}><span/><span/><span/></li>)}</ul>
  </div>;
  if (c.status === 'error') return <div className="admin-state"><p role="alert" className="visible-error">{c.message}</p><button type="button" className="button-secondary" onClick={c.reload}>Tentar novamente</button></div>;
  if (!c.items.length) return <div className="empty admin-empty">{empty}</div>;
  return <>
    <ul className="admin-list" aria-label={label}>{c.items.map(item => <li key={item.id}>{children(item)}</li>)}</ul>
    {c.moreStatus === 'error' && <div className="admin-state"><p role="alert" className="visible-error">{c.moreMessage}</p><button type="button" className="button-secondary" onClick={c.staleCursor ? c.reload : c.loadMore}>{c.staleCursor ? 'Recarregar lista' : 'Tentar novamente'}</button></div>}
    {c.nextCursor && c.moreStatus !== 'error' && <button type="button" className="button-secondary admin-more" onClick={c.loadMore} disabled={c.moreStatus === 'loading'} aria-busy={c.moreStatus === 'loading'}>{c.moreStatus === 'loading' ? `Carregando mais ${noun}…` : `Carregar mais ${noun}`}</button>}
  </>;
}
