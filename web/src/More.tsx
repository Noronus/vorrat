import { useEffect, useState } from 'react';
import { api, attempt, Chips, confirmDialog, native, promptDialog, Sheet, toast, useLoad, type User } from './lib';

const b64ToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
const standalone = window.matchMedia('(display-mode: standalone)').matches || (navigator as any).standalone === true;

let installEvent: any = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvent = e; });

function NativePush() {
  const [on, setOn] = useState(() => native!.notificationsEnabled());
  useEffect(() => {
    const h = (e: Event) => setOn(!!(e as CustomEvent).detail);
    window.addEventListener('vorrat:native-notif', h);
    return () => window.removeEventListener('vorrat:native-notif', h);
  }, []);
  return (
    <div className="row wrap">
      {on ? <button className="btn" onClick={() => native!.setNotifications(false)}>Auf diesem Gerät ausschalten</button> : <button className="btn primary" onClick={() => native!.setNotifications(true)}>Auf diesem Gerät einschalten</button>}
      {on && <button className="btn" onClick={() => native!.testNotification()}>Test anzeigen</button>}
    </div>
  );
}

function ClaudeToken({ onSaved }: { onSaved: () => void }) {
  const [token, setToken] = useState('');
  return (
    <form className="form" onSubmit={async (e) => { e.preventDefault(); if (await attempt(() => api('/admin/settings', { method: 'PUT', body: { claudeToken: token } }), token ? 'Token gespeichert' : 'Token entfernt')) { setToken(''); onSaved(); } }}>
      <label><span className="lbl">Claude-Token aus <code>claude setup-token</code>. Wird nie wieder angezeigt.</span>
        <input type="password" autoComplete="off" placeholder="sk-ant-oat01-…" value={token} onChange={(e) => setToken(e.target.value)} />
      </label>
      <button className="btn">{token ? 'Token speichern' : 'Token entfernen'}</button>
    </form>
  );
}

function Diet() {
  const { data, reload } = useLoad<{ diet: string }>('/settings');
  if (!data) return null;
  return (
    <Chips
      options={[{ value: 'omnivor', label: 'Alles' }, { value: 'vegetarisch', label: 'Vegetarisch' }, { value: 'vegan', label: 'Vegan' }]}
      value={data.diet}
      onChange={async (diet) => { await attempt(() => api('/settings', { method: 'PUT', body: { diet } })); reload(); }} />
  );
}

/** Persönliche Vorlieben: gelten nur für das eigene Konto und fließen in die eigenen Anfragen an Claude ein */
function Prefs() {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  useEffect(() => { api<{ prefs: string }>('/settings').then((s) => { setText(s.prefs); setSaved(s.prefs); }).catch(() => setText('')); }, []);
  if (text === null) return null;
  return (
    <form className="form" onSubmit={async (e) => { e.preventDefault(); if (await attempt(() => api('/settings', { method: 'PUT', body: { prefs: text } }), 'Gespeichert')) setSaved(text.trim()); }}>
      <textarea rows={3} maxLength={500} value={text} onChange={(e) => setText(e.target.value)} placeholder="z. B. keine Pilze, gern scharf, unter der Woche höchstens 30 Minuten" />
      <button className="btn" disabled={text.trim() === saved}>Speichern</button>
    </form>
  );
}

function Push() {
  const supported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    if (!supported) return;
    navigator.serviceWorker.ready.then((r) => r.pushManager.getSubscription()).then((s) => setOn(!!s)).catch(() => setOn(false));
  }, [supported]);

  async function enable() {
    await attempt(async () => {
      if ((await Notification.requestPermission()) !== 'granted') throw new Error('Benachrichtigungen sind im Browser blockiert');
      const reg = await navigator.serviceWorker.ready;
      const { key } = await api('/push/key');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) });
      await api('/push/subscribe', { body: { subscription: sub.toJSON() } });
      setOn(true);
    }, 'Erinnerungen sind an');
  }
  async function disable() {
    await attempt(async () => {
      const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
      if (sub) { await api('/push/unsubscribe', { body: { endpoint: sub.endpoint } }); await sub.unsubscribe(); }
      setOn(false);
    }, 'Erinnerungen sind aus');
  }
  if (!supported)
    return <p className="muted">{isIos && !standalone ? 'Auf dem iPhone gehen Erinnerungen erst, nachdem du die App zum Home-Bildschirm hinzugefügt hast (Teilen → „Zum Home-Bildschirm“).' : 'Dieser Browser unterstützt keine Push-Benachrichtigungen.'}</p>;
  return (
    <div className="row wrap">
      {on ? <button className="btn" onClick={disable}>Auf diesem Gerät ausschalten</button> : <button className="btn primary" onClick={enable}>Auf diesem Gerät einschalten</button>}
      {on && <button className="btn" onClick={() => attempt(() => api('/push/test', { body: {} }), 'Test gesendet')}>Test senden</button>}
    </div>
  );
}

function TwoFactor({ user, refresh }: { user: User; refresh: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState<string[] | null>(null);
  async function confirmCode() {
    const res = await attempt(() => api('/auth/totp/enable', { body: { code } }));
    if (res) { setRecovery(res.recoveryCodes); setSetup(null); setCode(''); refresh(); }
  }
  async function disable() {
    const password = await promptDialog('2FA ausschalten', { text: 'Zum Abschalten dein Passwort eingeben.', type: 'password', ok: 'Ausschalten' });
    if (!password) return;
    if (await attempt(() => api('/auth/totp/disable', { body: { password } }), '2FA ist aus')) refresh();
  }
  return (
    <>
      {user.totpEnabled
        ? <div className="row between"><span>Zwei-Faktor-Anmeldung ist <strong>an</strong></span><button className="btn small" onClick={disable}>Ausschalten</button></div>
        : <button className="btn primary" onClick={async () => setSetup((await attempt(() => api('/auth/totp/start', { body: {} }))) || null)}>Zwei-Faktor-Anmeldung einrichten</button>}
      {setup && (
        <Sheet title="2FA einrichten" onClose={() => setSetup(null)}>
          <form className="form" onSubmit={(e) => { e.preventDefault(); confirmCode(); }}>
            <p>1. QR-Code mit deiner Authenticator-App scannen (Aegis, 2FAS, Google Authenticator …).</p>
            <img className="qr" src={setup.qr} alt="QR-Code für die Authenticator-App" />
            <p className="muted">Oder Schlüssel von Hand eingeben: <code>{setup.secret}</code></p>
            <label>2. Den 6-stelligen Code eingeben<input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} autoFocus /></label>
            <button className="btn primary">Aktivieren</button>
          </form>
        </Sheet>
      )}
      {recovery && (
        <Sheet title="Notfall-Codes" onClose={() => setRecovery(null)}>
          <p>2FA ist an. Bewahre diese Codes sicher auf. Jeder gilt einmal, falls du dein Handy verlierst. Sie werden nur jetzt angezeigt.</p>
          <pre className="codes">{recovery.join('\n')}</pre>
          <button className="btn" onClick={() => navigator.clipboard?.writeText(recovery.join('\n')).then(() => toast('Kopiert'))}>Kopieren</button>
        </Sheet>
      )}
    </>
  );
}

function Password() {
  const [open, setOpen] = useState(false);
  const [oldPassword, setOld] = useState('');
  const [newPassword, setNew] = useState('');
  if (!open) return <button className="btn" onClick={() => setOpen(true)}>Passwort ändern</button>;
  return (
    <form className="form" onSubmit={async (e) => { e.preventDefault(); if (await attempt(() => api('/auth/password', { body: { oldPassword, newPassword } }), 'Passwort geändert')) { setOpen(false); setOld(''); setNew(''); } }}>
      <label>Altes Passwort<input type="password" autoComplete="current-password" value={oldPassword} onChange={(e) => setOld(e.target.value)} /></label>
      <label>Neues Passwort<input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNew(e.target.value)} /></label>
      <button className="btn primary">Ändern</button>
    </form>
  );
}

function Sessions() {
  const { data, reload } = useLoad<any[]>('/auth/sessions');
  const device = (ua: string) => (/Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iPhone/iPad' : /Windows/.test(ua) ? 'Windows' : /Mac/.test(ua) ? 'Mac' : /Linux/.test(ua) ? 'Linux' : 'Gerät') + (/Firefox/.test(ua) ? ' · Firefox' : /Edg/.test(ua) ? ' · Edge' : /Chrome/.test(ua) ? ' · Chrome' : /Safari/.test(ua) ? ' · Safari' : '');
  return (
    <div className="list">
      {data?.map((s) => (
        <div key={s.id} className="list-row">
          <div className="grow">
            <strong>{device(s.userAgent || '')}</strong>{s.current && <span className="badge ok"> dieses Gerät</span>}
            <div className="muted">zuletzt aktiv {new Date(s.lastSeen).toLocaleDateString('de-DE')}</div>
          </div>
          {!s.current && <button className="btn small" onClick={async () => { await attempt(() => api(`/auth/sessions/${s.id}`, { method: 'DELETE' }), 'Abgemeldet'); reload(); }}>Abmelden</button>}
        </div>
      ))}
    </div>
  );
}

function Admin({ me }: { me: User }) {
  const users = useLoad<any[]>('/admin/users');
  const invites = useLoad<any[]>('/admin/invites');
  const settings = useLoad<any>('/settings');
  const ai = useLoad<{ configured: boolean }>('/ai/status');
  const link = (code: string) => `${location.origin}/?invite=${code}`;
  const share = (code: string) => (navigator.share ? navigator.share({ title: 'Vorrat', text: 'Einladung zu unserem Vorrat', url: link(code) }).catch(() => {}) : navigator.clipboard.writeText(link(code)).then(() => toast('Link kopiert')));
  const set = async (body: object) => { await attempt(() => api('/admin/settings', { method: 'PUT', body })); settings.reload(); };
  return (
    <>
      <section className="card">
        <h3>Mitbewohner</h3>
        <div className="list">
          {users.data?.map((u) => (
            <div key={u.id} className="list-row">
              <div className="grow"><strong>{u.username}</strong><div className="muted">{u.isAdmin ? 'Admin · ' : ''}2FA {u.totpEnabled ? 'an' : 'aus'}</div></div>
              {u.totpEnabled && u.id !== me.id && <button className="btn small" onClick={async () => { if (await confirmDialog(`2FA von ${u.username} zurücksetzen?`, { ok: 'Zurücksetzen', danger: true })) { await attempt(() => api(`/admin/users/${u.id}/reset-2fa`, { body: {} })); users.reload(); } }}>2FA zurücksetzen</button>}
              {u.id !== me.id && <button className="btn small danger" onClick={async () => { if (await confirmDialog(`${u.username} löschen?`, { text: 'Das Konto wird endgültig gelöscht.', ok: 'Löschen', danger: true })) { await attempt(() => api(`/admin/users/${u.id}`, { method: 'DELETE' })); users.reload(); } }}>Löschen</button>}
            </div>
          ))}
          {invites.data?.map((i) => (
            <div key={i.code} className="list-row">
              <div className="grow"><strong>Offene Einladung</strong><div className="muted ellipsis">{link(i.code)}</div></div>
              <button className="btn small" onClick={() => share(i.code)}>Teilen</button>
              <button className="icon-btn" aria-label="Einladung löschen" onClick={async () => { await attempt(() => api(`/admin/invites/${i.code}`, { method: 'DELETE' })); invites.reload(); }}>✕</button>
            </div>
          ))}
        </div>
        <button className="btn" onClick={async () => { const r = await attempt(() => api('/admin/invites', { body: {} })); if (r) { invites.reload(); share(r.code); } }}>Jemanden einladen</button>
      </section>
      <section className="card">
        <h3>Claude und Erinnerungen</h3>
        <p className={ai.data?.configured ? 'muted' : 'error'}>{ai.data?.configured ? 'Claude ist auf dem Server verbunden.' : 'Claude ist noch nicht verbunden. Auf einem PC `claude setup-token` ausführen und das Token hier einfügen.'}</p>
        <ClaudeToken onSaved={ai.reload} />
        {settings.data && (
          <div className="form">
            <label>Modell
              <select value={settings.data.aiModel} onChange={(e) => set({ aiModel: e.target.value })}>
                <option value="sonnet">Sonnet (bessere Rezepte)</option>
                <option value="haiku">Haiku (schneller, sparsamer)</option>
              </select>
            </label>
            <label>Erinnern, wenn etwas in so vielen Tagen abläuft
              <select value={settings.data.reminderDays} onChange={(e) => set({ reminderDays: Number(e.target.value) })}>
                {[0, 1, 2, 3, 5, 7].map((d) => <option key={d} value={d}>{d === 0 ? 'erst am Ablauftag' : `${d} Tag${d > 1 ? 'e' : ''} vorher`}</option>)}
              </select>
            </label>
            <label>Uhrzeit der täglichen Erinnerung
              <select value={settings.data.reminderHour} onChange={(e) => set({ reminderHour: Number(e.target.value) })}>
                {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{h}:00 Uhr</option>)}
              </select>
            </label>
          </div>
        )}
      </section>
    </>
  );
}

export function More({ user, refreshUser }: { user: User; refreshUser: () => void }) {
  const [canInstall, setCanInstall] = useState(!!installEvent);
  useEffect(() => {
    const on = () => setCanInstall(true);
    window.addEventListener('beforeinstallprompt', on);
    return () => window.removeEventListener('beforeinstallprompt', on);
  }, []);
  return (
    <>
      <section className="card">
        <h3>Ablauf-Erinnerungen</h3>
        {native ? <NativePush /> : <Push />}
      </section>
      <section className="card">
        <h3>Ernährung</h3>
        <p className="muted">Gilt für alle Rezeptvorschläge und Wochenpläne im Haushalt. Ein Wunsch beim Kochen kann davon abweichen.</p>
        <Diet />
      </section>
      <section className="card">
        <h3>Meine Vorlieben</h3>
        <p className="muted">Nur für dein Konto. Claude berücksichtigt sie bei allem, was du anfragst.</p>
        <Prefs />
      </section>
      {!standalone && !native && (
        <section className="card">
          <h3>Als App installieren</h3>
          {canInstall
            ? <button className="btn primary" onClick={async () => { await installEvent.prompt(); installEvent = null; setCanInstall(false); }}>Installieren</button>
            : <p className="muted">{isIos ? 'In Safari: Teilen-Symbol → „Zum Home-Bildschirm“.' : 'Im Browser-Menü: „App installieren“ bzw. „Zum Startbildschirm hinzufügen“.'}</p>}
        </section>
      )}
      <section className="card">
        <h3>Sicherheit · {user.username}</h3>
        <TwoFactor user={user} refresh={refreshUser} />
        <Password />
        <h4>Angemeldete Geräte</h4>
        <Sessions />
      </section>
      {user.isAdmin && <Admin me={user} />}
      {native && <button className="btn" onClick={() => native!.changeServer()}>Server-Adresse ändern</button>}
      <button className="btn danger" onClick={async () => { await attempt(() => api('/auth/logout', { body: {} })); location.reload(); }}>Abmelden</button>
    </>
  );
}
