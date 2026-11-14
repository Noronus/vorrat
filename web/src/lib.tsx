import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

// ---------- Typen ----------
export type Item = {
  id: number; name: string; brand: string | null; barcode: string | null; image_url: string | null;
  unit: string; package_amount: number; count: number;
  remaining_amount: number; expires_on: string | null; note: string | null; category?: string | null; tags?: string | null; consumed_at?: string | null;
};
export type Ingredient = { name: string; amount: string; in_stock?: boolean };
export type Recipe = {
  emoji?: string;
  id?: number; title: string; description?: string | null; servings?: number | null; time_minutes?: number | null;
  ingredients: Ingredient[]; steps: string[]; uses_expiring?: string[]; source?: string;
  /** Je Schritt die Indizes der Zutaten, die darin gebraucht werden */
  step_ingredients?: number[][] | null;
};
export type PlanEntry = { id: number; date: string; slot: string; recipe_id: number | null; title: string };
export type ShoppingItem = { id: number; name: string; amount: string | null; done: number; item_id: number | null; stocked_item_id: number | null; unit: string | null; package_amount: number | null; category: string | null; brand: string | null };

/** Klein und ohne Umlaut-Unterschiede: "muesli" und "Müsli" treffen dasselbe */
export const fold = (s: string) => s.toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** Jedes Suchwort muss vorkommen: im Namen, in der Marke, der Warengruppe, der Notiz oder den Suchbegriffen von Claude */
export function matches(i: Pick<Item, 'name' | 'brand' | 'category' | 'tags' | 'note'>, query: string) {
  const words = fold(query).split(/\s+/).filter(Boolean);
  const hay = fold(`${i.name} ${i.brand || ''} ${i.category || ''} ${i.tags || ''} ${i.note || ''}`);
  return words.every((w) => hay.includes(w));
}
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
  scan(): void; scanStart?(x: number, y: number, w: number, h: number): void; scanStop?(): void; torch?(on: boolean): boolean;
  notificationsEnabled(): boolean; setNotifications(on: boolean): void; testNotification(): void; changeServer(): void;
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

// ---------- Rückfragen (statt confirm/prompt des Browsers) ----------
type DialogReq = { title: string; text?: string; ok: string; cancel: string; danger?: boolean; input?: { type: string; placeholder?: string; value?: string; inputMode?: string; suffix?: string }; resolve: (v: any) => void };
const dialogEvent = (d: DialogReq) => window.dispatchEvent(new CustomEvent('vorrat:dialog', { detail: d }));
/** Ja/Nein-Frage im App-Stil. Liefert true bei Bestätigung. */
export const confirmDialog = (title: string, o: { text?: string; ok?: string; cancel?: string; danger?: boolean } = {}) =>
  new Promise<boolean>((resolve) => dialogEvent({ title, ok: 'OK', cancel: 'Abbrechen', ...o, resolve }));
/** Eingabe im App-Stil. Liefert null bei Abbruch. */
export const promptDialog = (title: string, o: { text?: string; ok?: string; type?: string; placeholder?: string; value?: string; inputMode?: string; suffix?: string } = {}) =>
  new Promise<string | null>((resolve) => dialogEvent({ title, text: o.text, ok: o.ok || 'OK', cancel: 'Abbrechen', input: { type: o.type || 'text', placeholder: o.placeholder, value: o.value, inputMode: o.inputMode, suffix: o.suffix }, resolve }));

export function Dialogs() {
  const [queue, setQueue] = useState<DialogReq[]>([]);
  const [value, setValue] = useState('');
  useEffect(() => {
    const on = (e: Event) => setQueue((q) => [...q, (e as CustomEvent).detail]);
    window.addEventListener('vorrat:dialog', on);
    return () => window.removeEventListener('vorrat:dialog', on);
  }, []);
  const d = queue[0];
  useEffect(() => {
    if (!d) return;
    const h = () => close(false);
    backStack.push(h);
    return () => { const i = backStack.lastIndexOf(h); if (i >= 0) backStack.splice(i, 1); };
  }, [d]);
  useEffect(() => {
    if (!d) return;
    setValue(d.input?.value || '');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); close(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [d]);
  if (!d) return null;
  function close(ok: boolean) {
    d.resolve(d.input ? (ok ? value : null) : ok);
    setQueue((q) => q.slice(1));
  }
  return (
    <div className="dialog-back" onClick={(e) => e.target === e.currentTarget && close(false)}>
      <form className="dialog" role="alertdialog" aria-label={d.title} onSubmit={(e) => { e.preventDefault(); close(true); }}>
        <h2>{d.title}</h2>
        {d.text && <p>{d.text}</p>}
        {d.input && (
          <div className="row">
            <input type={d.input.type} inputMode={d.input.inputMode as any} placeholder={d.input.placeholder} value={value} onChange={(e) => setValue(e.target.value)} onFocus={(e) => e.target.select()} autoFocus />
            {d.input.suffix && <span className="lbl">{d.input.suffix}</span>}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={() => close(false)}>{d.cancel}</button>
          <button className={'btn ' + (d.danger ? 'danger-fill' : 'primary')} autoFocus={!d.input}>{d.ok}</button>
        </div>
      </form>
    </div>
  );
}

// ---------- Rezeptmengen umrechnen ----------
const FRAC: Record<string, number> = { '½': 0.5, '¼': 0.25, '¾': 0.75, '⅓': 1 / 3, '⅔': 2 / 3 };
const NUM = String.raw`(?:\d+\s+\d+\/\d+|\d+\/\d+|\d+(?:[.,]\d+)?(?:\s*[½¼¾⅓⅔])?|[½¼¾⅓⅔])`;
const parseNum = (t: string) => {
  t = t.trim();
  let m = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return +m[1] + +m[2] / +m[3];
  m = t.match(/^(\d+)\/(\d+)$/);
  if (m) return +m[1] / +m[2];
  m = t.match(/^(\d+(?:[.,]\d+)?)?\s*([½¼¾⅓⅔])?$/);
  return m ? (m[1] ? Number(m[1].replace(',', '.')) : 0) + (m[2] ? FRAC[m[2]] : 0) : NaN;
};
const fmtAmount = (n: number) => {
  const r = n >= 100 ? Math.round(n / 5) * 5 : n >= 10 ? Math.round(n) : n >= 1 ? Math.round(n * 2) / 2 : Math.round(n * 4) / 4;
  const whole = Math.floor(r), rest = r - whole;
  const frac = rest === 0.5 ? '½' : rest === 0.25 ? '¼' : rest === 0.75 ? '¾' : '';
  if (frac) return whole ? `${whole}${frac}` : frac;
  return String(Math.round(r * 10) / 10).replace('.', ',');
};
/** "400 g" mal 1,5 = "600 g"; "1-2 Zehen" mal 2 = "2-4 Zehen"; Text ohne Zahl bleibt, wie er ist */
export function scaleAmount(amount: string, factor: number) {
  if (factor === 1 || !amount) return amount;
  const m = amount.match(new RegExp(`^(ca\\.\\s*)?(${NUM})(?:\\s*[-–]\\s*(${NUM}))?(.*)$`));
  if (!m) return amount;
  const a = parseNum(m[2]), b = m[3] ? parseNum(m[3]) : NaN;
  if (!(a > 0)) return amount;
  return `${m[1] || ''}${fmtAmount(a * factor)}${b > 0 ? `–${fmtAmount(b * factor)}` : ''}${m[4]}`;
}
export function scaleRecipe(r: Recipe, servings: number): Recipe {
  const base = r.servings || servings;
  if (base === servings) return r;
  return { ...r, servings, ingredients: r.ingredients.map((i) => ({ ...i, amount: scaleAmount(i.amount, servings / base) })) };
}

// ---------- Bausteine ----------
/** Zurück-Taste (Android-App): schließt zuerst das oberste offene Fenster */
const backStack: (() => void)[] = [];
(window as any).vorratBack = () => { const top = backStack[backStack.length - 1]; if (!top) return false; top(); return true; };
export function useBack(fn: () => void) {
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    const h = () => ref.current();
    backStack.push(h);
    return () => { const i = backStack.lastIndexOf(h); if (i >= 0) backStack.splice(i, 1); };
  }, []);
}

export function Sheet({ title, onClose, children, full }: { title: string; onClose: () => void; children: ReactNode; full?: boolean }) {
  useBack(onClose);
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
