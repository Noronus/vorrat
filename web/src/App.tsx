import { useCallback, useEffect, useState } from 'react';
import { Cook } from './Cook';
import { Inventory } from './Inventory';
import { api, Dialogs, startLive, Toasts, useLoad, type Item, type User } from './lib';
import { More } from './More';
import { Scanner } from './Scanner';
import { Shopping } from './Shopping';

type Tab = 'vorrat' | 'kochen' | 'einkauf' | 'mehr';
const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'vorrat', label: 'Vorrat', icon: 'M4 7h16v13H4zM4 7l2-4h12l2 4M9 11h6' },
  { id: 'kochen', label: 'Kochen', icon: 'M5 11h14v5a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4zM3 11h18M9 7c0-2 2-2 2-4M14 7c0-2 2-2 2-4' },
  { id: 'einkauf', label: 'Einkauf', icon: 'M4 5h2l2 11h10l2-8H7M9 20h.01M17 20h.01' },
  { id: 'mehr', label: 'Mehr', icon: 'M5 12h.01M12 12h.01M19 12h.01' },
];
let scanFrom = '';
const readHash = (): { tab: Tab; scan: boolean } => {
  const h = location.hash.slice(1);
  return { tab: (TABS.find((t) => t.id === h)?.id || 'vorrat') as Tab, scan: h === 'scan' };
};

function Login({ setupNeeded, onDone }: { setupNeeded: boolean; onDone: () => void }) {
  const invite = new URLSearchParams(location.search).get('invite');
  const mode = setupNeeded ? 'setup' : invite ? 'register' : 'login';
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needTotp, setNeedTotp] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await api(`/auth/${mode}`, { body: { username, password, invite, code: needTotp ? code : undefined } });
      if (invite) history.replaceState(null, '', '/');
      onDone();
    } catch (err: any) {
      if (err.data?.needTotp && !needTotp) setNeedTotp(true);
      else setError(err.message);
    }
    setBusy(false);
  }
  return (
    <main className="login">
      <img src="/icon.svg" alt="" width={84} height={84} />
      <h1>Vorrat</h1>
      <p className="muted">{mode === 'setup' ? 'Erster Start: Lege dein Admin-Konto an.' : mode === 'register' ? 'Du wurdest eingeladen. Lege dein Konto an.' : 'Anmelden'}</p>
      <form className="form" onSubmit={submit}>
        <label>Benutzername<input autoComplete="username" autoCapitalize="none" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></label>
        <label>Passwort{mode !== 'login' && ' (mind. 10 Zeichen)'}<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {needTotp && <label>Code aus der Authenticator-App (oder Notfall-Code)<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></label>}
        {error && <p className="error">{error}</p>}
        <button className="btn primary" disabled={busy}>{mode === 'login' ? 'Anmelden' : 'Konto anlegen'}</button>
      </form>
    </main>
  );
}

function Main({ user, refreshUser }: { user: User; refreshUser: () => void }) {
  const [{ tab, scan }, setNav] = useState(readHash);
  const items = useLoad<Item[]>('/items');
  useEffect(startLive, []);
  useEffect(() => {
    const on = () => { const n = readHash(); if (!n.scan) scanFrom = ''; setNav(n); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const go = (t: Tab) => { location.hash = t; };
  // Schließen = einen Schritt zurück, damit man dort landet, wo man vorher war
  const openScan = () => { scanFrom = location.hash || '#vorrat'; location.hash = 'scan'; };
  const closeScan = useCallback(() => { if (scanFrom) { scanFrom = ''; history.back(); } else location.hash = 'vorrat'; }, []);

  return (
    <>
      <header className="top">
        <p className="eyebrow">{new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
        <h1>{TABS.find((t) => t.id === tab)!.label}</h1>
      </header>
      <main className={`page page-${tab}`}>
        {tab === 'vorrat' && <Inventory items={items.data} reload={items.reload} onScan={openScan} />}
        {tab === 'kochen' && <Cook />}
        {tab === 'einkauf' && <Shopping />}
        {tab === 'mehr' && <More user={user} refreshUser={refreshUser} />}
      </main>
      <nav className="tabs">
        <div className="brand"><img src="/icon.svg" alt="" width={36} height={36} /><strong>Vorrat</strong></div>
        {TABS.slice(0, 2).map((t) => <TabBtn key={t.id} t={t} on={tab === t.id} go={go} />)}
        <button className="fab" onClick={openScan} aria-label="Scannen und hinzufügen">
          <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3M8 8v8M12 8v8M16 8v8" /></svg>
          <span className="fab-label">Hinzufügen</span>
        </button>
        {TABS.slice(2).map((t) => <TabBtn key={t.id} t={t} on={tab === t.id} go={go} />)}
      </nav>
      {scan && <Scanner onClose={closeScan} onChanged={items.reload} />}
    </>
  );
}

function TabBtn({ t, on, go }: { t: (typeof TABS)[number]; on: boolean; go: (t: Tab) => void }) {
  return (
    <button className={on ? 'on' : ''} onClick={() => go(t.id)} aria-current={on ? 'page' : undefined}>
      <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d={t.icon} /></svg>
      <span>{t.label}</span>
    </button>
  );
}

export function App() {
  const [state, setState] = useState<{ setupNeeded: boolean; user: User | null } | null>(null);
  const [offline, setOffline] = useState(false);
  const load = useCallback(() => api('/auth/state').then((s) => { setState(s); setOffline(false); }).catch(() => setOffline(true)), []);
  useEffect(() => {
    load();
    window.addEventListener('vorrat:logout', load);
    return () => window.removeEventListener('vorrat:logout', load);
  }, [load]);

  return (
    <>
      {offline && !state ? <main className="login"><p>Server nicht erreichbar.</p><button className="btn" onClick={load}>Nochmal versuchen</button></main>
        : !state ? null
        : state.user ? <Main user={state.user} refreshUser={load} />
        : <Login setupNeeded={state.setupNeeded} onDone={load} />}
      <Toasts />
      <Dialogs />
    </>
  );
}
