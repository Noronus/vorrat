import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

// ---------- Typen ----------
export type Item = {
  id: number; name: string; brand: string | null; barcode: string | null; image_url: string | null;
  unit: string; package_amount: number; count: number;
  remaining_amount: number; expires_on: string | null; note: string | null; category?: string | null;
};
export type Ingredient = { name: string; amount: string; in_stock?: boolean };
export type Recipe = {
  emoji?: string;
  id?: number; title: string; description?: string | null; servings?: number | null; time_minutes?: number | null;
  ingredients: Ingredient[]; steps: string[]; uses_expiring?: string[]; source?: string;
};
export type PlanEntry = { id: number; date: string; slot: string; recipe_id: number | null; title: string };
export type ShoppingItem = { id: number; name: string; amount: string | null; done: number };
export type User = { id: number; username: string; isAdmin: boolean; totpEnabled: boolean };
export type AiJob = { id: number; kind: string; status: 'running' | 'done' | 'error'; error: string | null; createdAt: string; params: any; result: any };

// ---------- API ----------
/** Seite neu laden, damit die Proxy-Anmeldeseite erscheint. Höchstens alle 30 s und nur online. */
function proxyLoginNeeded() {
  if (!navigator.onLine) return;
  try {
    const last = Number(sessionStorage.getItem('vorrat:reload') || 0);
    if (Date.now() - last < 30_000) return;
    sessionStorage.setItem('vorrat:reload', String(Date.now()));
  } catch { return; }
  location.reload();
}

/** Brücke zur Android-App (nur dort vorhanden) */
export const native: undefined | {
  scan(): void; notificationsEnabled(): boolean; setNotifications(on: boolean): void; testNotification(): void; changeServer(): void;
} = (window as any).VorratNative;
export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const hasBody = opts.body !== undefined;
  let res: Response;
  try {
    res = await fetch('/api' + path, {
      method: opts.method || (hasBody ? 'POST' : 'GET'),
      headers: hasBody ? { 'content-type': 'application/json' } : undefined,
      body: hasBody ? JSON.stringify(opts.body) : undefined,
      credentials: 'same-origin',
    });
  } catch {
    proxyLoginNeeded();
    throw new Error('Server nicht erreichbar');
  }
  // Antwort ohne App-Kennung = ein vorgeschalteter Proxy (z. B. NetBird-PIN) will eine neue Anmeldung
  if (!res.headers.get('x-vorrat')) {
    proxyLoginNeeded();
    throw new Error('Anmeldung am Proxy nötig');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) window.dispatchEvent(new Event('vorrat:logout'));
    const err: any = new Error(data.error || `Fehler ${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

/** Live-Abgleich: Der Server meldet, welches Thema sich geändert hat (items, shopping, plan ...) */
let live: EventSource | null = null;
export function startLive() {
  if (live || !('EventSource' in window)) return;
  live = new EventSource('/api/events');
  live.onmessage = (e) => window.dispatchEvent(new CustomEvent('vorrat:sync', { detail: e.data }));
}
export function onSync(fn: (topic: string) => void) {
  const h = (e: Event) => fn((e as CustomEvent).detail);
  window.addEventListener('vorrat:sync', h);
  return () => window.removeEventListener('vorrat:sync', h);
}

/** Lädt Daten; lädt neu, wenn ein anderes Gerät etwas ändert oder man in die App zurückkehrt */
export function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null);
  const reload = useCallback(async () => {
    try { setData(await api<T>(path)); } catch { /* 401 wird global behandelt */ }
  }, [path]);
  useEffect(() => {
    reload();
    const onVis = () => document.visibilityState === 'visible' && reload();
    document.addEventListener('visibilitychange', onVis);
    const topic = path.split(/[/?]/)[1];
    const off = onSync((t) => {
      if (t === topic || (t === 'admin' && (topic === 'settings' || topic === 'ai'))) reload();
    });
    return () => { off(); document.removeEventListener('visibilitychange', onVis); };
  }, [reload]);
  return { data, reload };
}

// ---------- Datum ----------
const pad = (n: number) => String(n).padStart(2, '0');
export const dateStr = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const addDays = (n: number) => { const d = new Date(); d.setDate(d.getDate() + n); return dateStr(d); };
export const addMonths = (n: number) => { const d = new Date(); d.setMonth(d.getMonth() + n); return dateStr(d); };
export const daysUntil = (s: string) => Math.round((Date.parse(s) - Date.parse(dateStr(new Date()))) / 864e5);
export const niceDate = (s: string) => new Date(s + 'T12:00').toLocaleDateString('de-DE', { weekday: 'short', day: 'numeric', month: 'numeric' });

export function expiry(s: string | null): { text: string; level: 'none' | 'ok' | 'soon' | 'bad' } {
  if (!s) return { text: '', level: 'none' };
  const d = daysUntil(s);
  if (d < 0) return { text: d === -1 ? 'seit gestern abgelaufen' : `seit ${-d} Tagen abgelaufen`, level: 'bad' };
  if (d === 0) return { text: 'läuft heute ab', level: 'bad' };
  if (d === 1) return { text: 'morgen', level: 'soon' };
  if (d <= 5) return { text: `in ${d} Tagen`, level: 'soon' };
  if (d <= 60) return { text: `in ${d} Tagen`, level: 'ok' };
  return { text: new Date(s + 'T12:00').toLocaleDateString('de-DE', { month: 'short', year: 'numeric' }), level: 'ok' };
}

// ---------- Mengen ----------
export const round = (n: number) => (n >= 100 ? Math.round(n) : Math.round(n * 10) / 10);
export const fmtNum = (n: number) => String(round(n)).replace('.', ',');
export function amountText(i: Pick<Item, 'unit' | 'package_amount' | 'count' | 'remaining_amount'>) {
  const full = i.package_amount * i.count;
  const packs = i.count > 1 ? ` · ${i.count} Pck.` : '';
  if (i.unit === '%') return `${fmtNum((i.remaining_amount / full) * 100)} % übrig${packs}`;
  if (i.remaining_amount >= full - 1e-6) return `${fmtNum(full)} ${i.unit}${packs}`;
  return `${fmtNum(i.remaining_amount)} von ${fmtNum(full)} ${i.unit}${packs}`;
}

// ---------- Toast ----------
export const toast = (msg: string) => window.dispatchEvent(new CustomEvent('vorrat:toast', { detail: msg }));
export function Toasts() {
  const [msg, setMsg] = useState('');
  const timer = useRef(0);
  useEffect(() => {
    const on = (e: Event) => {
      setMsg((e as CustomEvent).detail);
      clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setMsg(''), 2600);
    };
    window.addEventListener('vorrat:toast', on);
    return () => window.removeEventListener('vorrat:toast', on);
  }, []);
  return msg ? <div className="toast" role="status">{msg}</div> : null;
}
/** Führt eine Aktion aus und zeigt Fehler als Toast */
export async function attempt<T>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> {
  try { const r = await fn(); if (okMsg) toast(okMsg); return r; } catch (e: any) { toast(e.message || 'Fehler'); return undefined; }
}

// ---------- Bausteine ----------
export function Sheet({ title, onClose, children, full }: { title: string; onClose: () => void; children: ReactNode; full?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="sheet-back" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'sheet' + (full ? ' full' : '')} role="dialog" aria-label={title}>
        <div className="sheet-head">
          <h2>{title}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Schließen">✕</button>
        </div>
        <div className="sheet-body">{children}</div>
      </div>
    </div>
  );
}

export function Chips<T extends string | number | null>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button type="button" key={String(o.value)} className={'chip' + (o.value === value ? ' on' : '')} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Stepper({ value, onChange, min = 1, max = 99 }: { value: number; onChange: (n: number) => void; min?: number; max?: number }) {
  return (
    <div className="stepper">
      <button type="button" onClick={() => onChange(Math.max(min, value - 1))} aria-label="weniger">−</button>
      <span>{value}</span>
      <button type="button" onClick={() => onChange(Math.min(max, value + 1))} aria-label="mehr">+</button>
    </div>
  );
}
