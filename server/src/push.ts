import type { FastifyInstance } from 'fastify';
import webpush from 'web-push';
import { all, getSetting, nowIso, run, setSetting, today } from './db.ts';

let pub = getSetting('vapid_public');
let priv = getSetting('vapid_private');
if (!pub || !priv) {
  const k = webpush.generateVAPIDKeys();
  pub = k.publicKey; priv = k.privateKey;
  setSetting('vapid_public', pub); setSetting('vapid_private', priv);
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:vorrat@example.com', pub, priv);

async function sendTo(where: string, param: number | null, payload: object) {
  const subs = param == null ? all<any>('SELECT * FROM push_subs') : all<any>(`SELECT * FROM push_subs WHERE ${where}`, param);
  let sent = 0;
  for (const s of subs) {
    try {
      await webpush.sendNotification(JSON.parse(s.sub), JSON.stringify(payload), { TTL: 86400 });
      sent++;
    } catch (e: any) {
      if (e?.statusCode === 404 || e?.statusCode === 410) run('DELETE FROM push_subs WHERE endpoint=?', s.endpoint);
    }
  }
  return sent;
}

export function expiringItems(days: number) {
  return all<any>('SELECT name, expires_on FROM items WHERE consumed_at IS NULL AND expires_on IS NOT NULL AND expires_on<=? ORDER BY expires_on', today(days));
}

function label(expires: string) {
  const d = Math.round((Date.parse(expires) - Date.parse(today())) / 86400000);
  return d < 0 ? 'abgelaufen' : d === 0 ? 'heute' : d === 1 ? 'morgen' : `in ${d} Tagen`;
}

/** Text der Sammel-Erinnerung, oder count 0, wenn nichts ansteht */
export function reminderPayload() {
  const items = expiringItems(Number(getSetting('reminder_days', '3')));
  if (!items.length) return { count: 0, title: '', body: '' };
  const list = items.slice(0, 6).map((i) => `${i.name} (${label(i.expires_on)})`).join(', ');
  return {
    count: items.length,
    title: items.length === 1 ? '1 Lebensmittel läuft ab' : `${items.length} Lebensmittel laufen ab`,
    body: list + (items.length > 6 ? ` und ${items.length - 6} weitere` : ''),
  };
}

/** Einmal täglich zur eingestellten Stunde eine Sammel-Erinnerung an alle Geräte */
async function reminderTick() {
  const hour = Number(getSetting('reminder_hour', '9'));
  if (new Date().getHours() < hour || getSetting('last_reminder') === today()) return;
  setSetting('last_reminder', today());
  const p = reminderPayload();
  if (p.count) await sendTo('', null, { title: p.title, body: p.body, url: '/#vorrat' });
}

export function registerPush(app: FastifyInstance) {
  app.get('/api/push/key', async () => ({ key: pub }));
  app.post('/api/push/subscribe', async (req, reply) => {
    const sub = (req.body as any).subscription;
    if (!sub?.endpoint || !sub?.keys?.p256dh) return reply.code(400).send({ error: 'Ungültig' });
    run('INSERT OR REPLACE INTO push_subs(endpoint,user_id,sub,created_at) VALUES(?,?,?,?)', sub.endpoint, (req as any).user.id, JSON.stringify(sub), nowIso());
    return { ok: true };
  });
  app.post('/api/push/unsubscribe', async (req) => {
    run('DELETE FROM push_subs WHERE endpoint=?', String((req.body as any).endpoint || ''));
    return { ok: true };
  });
  app.post('/api/push/test', async (req) => ({
    sent: await sendTo('user_id=?', (req as any).user.id, { title: 'Vorrat', body: 'Benachrichtigungen funktionieren.', url: '/' }),
  }));

  setInterval(() => reminderTick().catch(() => {}), 5 * 60_000);
  setTimeout(() => reminderTick().catch(() => {}), 20_000);
}
