import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import * as OTPAuth from 'otpauth';
import QRCode from 'qrcode';
import { all, get, nowIso, run } from './db.ts';

const COOKIE = 'vorrat_sid';
const COOKIE_MAX_AGE = 400 * 86400; // Browser-Maximum; wird bei Nutzung laufend erneuert
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function hashPw(pw: string) {
  const salt = randomBytes(16);
  const h = scryptSync(pw, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return `scrypt$${salt.toString('hex')}$${h.toString('hex')}`;
}
export function checkPw(pw: string, stored: string) {
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const h = scryptSync(pw, Buffer.from(saltHex, 'hex'), 64, { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 });
  return timingSafeEqual(h, Buffer.from(hashHex, 'hex'));
}

const totpFor = (username: string, secret: string) =>
  new OTPAuth.TOTP({ issuer: 'Vorrat', label: username, secret: OTPAuth.Secret.fromBase32(secret) });

/** TOTP prüfen; jeder Code gilt nur einmal (Schutz gegen Mitlesen und Wiederverwenden) */
function verifyTotp(u: any, code: string) {
  const delta = totpFor(u.username, u.totp_secret).validate({ token: code, window: 1 });
  if (delta === null) return false;
  const step = Math.floor(Date.now() / 30000) + delta;
  if (u.totp_last_step && step <= u.totp_last_step) return false;
  run('UPDATE users SET totp_last_step=? WHERE id=?', step, u.id);
  return true;
}

// Sperre je Benutzername nach Fehlversuchen: ab 5 Fehlern 1 min, dann verdoppelnd bis 15 min
const fails = new Map<string, { n: number; until: number }>();
const DUMMY_HASH = hashPw('dummy-password-for-timing');
function lockedFor(name: string) {
  const f = fails.get(name);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
}
function noteFail(name: string, ip: string) {
  const f = fails.get(name) || { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = Date.now() + Math.min(60_000 * 2 ** (f.n - 5), 900_000);
  fails.set(name, f);
  if (fails.size > 5000) fails.clear();
  console.warn(`[auth] Fehlgeschlagene Anmeldung für "${name.slice(0, 40)}" von ${ip} (${f.n}x)`);
}

function setCookie(req: FastifyRequest, reply: FastifyReply, token: string) {
  reply.setCookie(COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', secure: req.protocol === 'https', maxAge: COOKIE_MAX_AGE,
  });
}
function createSession(req: FastifyRequest, reply: FastifyReply, userId: number) {
  const token = randomBytes(32).toString('base64url');
  const now = nowIso();
  run('INSERT INTO sessions(token_hash,user_id,created_at,last_seen,user_agent) VALUES(?,?,?,?,?)',
    sha(token), userId, now, now, String(req.headers['user-agent'] || '').slice(0, 300));
  setCookie(req, reply, token);
}

export type User = { id: number; username: string; is_admin: number; totp_enabled: number };
const publicUser = (u: any) => u && { id: u.id, username: u.username, isAdmin: !!u.is_admin, totpEnabled: !!u.totp_enabled };

function validCreds(username: unknown, password: unknown): string | null {
  if (typeof username !== 'string' || !/^[\w.\-äöüÄÖÜß]{2,32}$/.test(username)) return 'Benutzername: 2–32 Zeichen (Buchstaben, Zahlen, . _ -)';
  if (typeof password !== 'string' || password.length < 10 || password.length > 200) return 'Passwort: mindestens 10 Zeichen';
  return null;
}

export function registerAuth(app: FastifyInstance) {
  // Session-Prüfung für alle /api-Routen außer den öffentlichen
  const open = new Set(['/api/auth/state', '/api/auth/login', '/api/auth/setup', '/api/auth/register', '/api/health']);
  app.addHook('preHandler', async (req, reply) => {
    const path = req.url.split('?')[0];
    if (!path.startsWith('/api/')) return;
    const token = req.cookies[COOKIE];
    if (token) {
      const hash = sha(token);
      const row = get<any>(
        `SELECT u.id,u.username,u.is_admin,u.totp_enabled,s.last_seen FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=?`, hash);
      if (row) {
        (req as any).user = row;
        (req as any).sessionHash = hash;
        // Rollierend: höchstens einmal am Tag Cookie + last_seen auffrischen -> kein automatisches Abmelden
        if (Date.now() - Date.parse(row.last_seen) > 86400_000) {
          run('UPDATE sessions SET last_seen=? WHERE token_hash=?', nowIso(), hash);
          setCookie(req, reply, token);
        }
      }
    }
    if (!(req as any).user && !open.has(path)) return reply.code(401).send({ error: 'Nicht angemeldet' });
    if (path.startsWith('/api/admin/') && !(req as any).user?.is_admin) return reply.code(403).send({ error: 'Nur für Admins' });
  });

  const limited = { config: { rateLimit: { max: 10, timeWindow: '5 minutes' } } };

  app.get('/api/auth/state', async (req) => ({
    setupNeeded: !get('SELECT 1 FROM users LIMIT 1'),
    user: publicUser((req as any).user) || null,
  }));

  app.post('/api/auth/setup', limited, async (req, reply) => {
    if (get('SELECT 1 FROM users LIMIT 1')) return reply.code(400).send({ error: 'Bereits eingerichtet' });
    const { username, password } = req.body as any;
    const err = validCreds(username, password);
    if (err) return reply.code(400).send({ error: err });
    const r = run('INSERT INTO users(username,pw_hash,is_admin,created_at) VALUES(?,?,1,?)', username, hashPw(password), nowIso());
    createSession(req, reply, Number(r.lastInsertRowid));
    return { ok: true };
  });

  app.post('/api/auth/register', limited, async (req, reply) => {
    const { invite, username, password } = req.body as any;
    const inv = get<any>('SELECT * FROM invites WHERE code=? AND used_by IS NULL AND created_at>?', String(invite || ''), new Date(Date.now() - 7 * 86400_000).toISOString());
    if (!inv) return reply.code(400).send({ error: 'Einladung ungültig, abgelaufen oder schon benutzt' });
    const err = validCreds(username, password);
    if (err) return reply.code(400).send({ error: err });
    if (get('SELECT 1 FROM users WHERE username=?', username)) return reply.code(400).send({ error: 'Benutzername vergeben' });
    const r = run('INSERT INTO users(username,pw_hash,created_at) VALUES(?,?,?)', username, hashPw(password), nowIso());
    run('UPDATE invites SET used_by=? WHERE code=?', r.lastInsertRowid, inv.code);
    createSession(req, reply, Number(r.lastInsertRowid));
    return { ok: true };
  });

  app.post('/api/auth/login', limited, async (req, reply) => {
    const { username, password, code } = req.body as any;
    const name = String(username || '').toLowerCase().slice(0, 64);
    const wait = lockedFor(name);
    if (wait) return reply.code(429).send({ error: `Zu viele Fehlversuche. Bitte ${wait} s warten.` });
    const u = get<any>('SELECT * FROM users WHERE username=?', name);
    // Auch bei unbekanntem Namen hashen, damit die Antwortzeit nichts verrät
    const pwOk = typeof password === 'string' && checkPw(password.slice(0, 200), u ? u.pw_hash : DUMMY_HASH);
    if (!u || !pwOk) {
      noteFail(name, req.ip);
      return reply.code(401).send({ error: 'Benutzername oder Passwort falsch' });
    }
    if (u.totp_enabled) {
      if (!code) return reply.code(401).send({ needTotp: true, error: '2FA-Code nötig' });
      const c = String(code).replace(/\s/g, '').slice(0, 20);
      let ok = verifyTotp(u, c);
      if (!ok) {
        const codes: string[] = JSON.parse(u.recovery_codes);
        const i = codes.indexOf(sha(c.toLowerCase()));
        if (i >= 0) {
          codes.splice(i, 1);
          run('UPDATE users SET recovery_codes=? WHERE id=?', JSON.stringify(codes), u.id);
          ok = true;
        }
      }
      if (!ok) {
        noteFail(name, req.ip);
        return reply.code(401).send({ needTotp: true, error: '2FA-Code falsch' });
      }
    }
    fails.delete(name);
    createSession(req, reply, u.id);
    return { ok: true };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    run('DELETE FROM sessions WHERE token_hash=?', (req as any).sessionHash);
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/api/auth/password', limited, async (req, reply) => {
    const me = (req as any).user;
    const { oldPassword, newPassword } = req.body as any;
    const u = get<any>('SELECT * FROM users WHERE id=?', me.id);
    if (typeof oldPassword !== 'string' || !checkPw(oldPassword, u.pw_hash)) return reply.code(400).send({ error: 'Altes Passwort falsch' });
    const err = validCreds(u.username, newPassword);
    if (err) return reply.code(400).send({ error: err });
    run('UPDATE users SET pw_hash=? WHERE id=?', hashPw(newPassword), me.id);
    run('DELETE FROM sessions WHERE user_id=? AND token_hash<>?', me.id, (req as any).sessionHash);
    return { ok: true };
  });

  // --- 2FA (TOTP) ---
  app.post('/api/auth/totp/start', async (req, reply) => {
    const me = (req as any).user;
    if (me.totp_enabled) return reply.code(400).send({ error: '2FA ist schon aktiv' });
    const secret = new OTPAuth.Secret({ size: 20 }).base32;
    run('UPDATE users SET totp_secret=? WHERE id=?', secret, me.id);
    const url = totpFor(me.username, secret).toString();
    return { secret, url, qr: await QRCode.toDataURL(url, { margin: 1, width: 240 }) };
  });
  app.post('/api/auth/totp/enable', limited, async (req, reply) => {
    const me = (req as any).user;
    const u = get<any>('SELECT * FROM users WHERE id=?', me.id);
    const code = String((req.body as any).code || '').replace(/\s/g, '');
    if (!u.totp_secret || !verifyTotp(u, code))
      return reply.code(400).send({ error: 'Code falsch' });
    const recovery = Array.from({ length: 8 }, () => randomBytes(5).toString('hex'));
    run('UPDATE users SET totp_enabled=1, recovery_codes=? WHERE id=?', JSON.stringify(recovery.map(sha)), me.id);
    return { recoveryCodes: recovery };
  });
  app.post('/api/auth/totp/disable', limited, async (req, reply) => {
    const me = (req as any).user;
    const u = get<any>('SELECT * FROM users WHERE id=?', me.id);
    if (!checkPw(String((req.body as any).password || ''), u.pw_hash)) return reply.code(400).send({ error: 'Passwort falsch' });
    run("UPDATE users SET totp_enabled=0, totp_secret=NULL, recovery_codes='[]' WHERE id=?", me.id);
    return { ok: true };
  });

  // --- Geräte / Sitzungen ---
  app.get('/api/auth/sessions', async (req) =>
    all<any>('SELECT token_hash,created_at,last_seen,user_agent FROM sessions WHERE user_id=? ORDER BY last_seen DESC', (req as any).user.id)
      .map((s) => ({ id: s.token_hash.slice(0, 16), createdAt: s.created_at, lastSeen: s.last_seen, userAgent: s.user_agent, current: s.token_hash === (req as any).sessionHash })));
  app.delete('/api/auth/sessions/:id', async (req) => {
    run("DELETE FROM sessions WHERE user_id=? AND token_hash LIKE ? || '%'", (req as any).user.id, String((req.params as any).id).replace(/[^0-9a-f]/g, ''));
    return { ok: true };
  });

  // --- Admin: Nutzer + Einladungen ---
  app.get('/api/admin/users', async () =>
    all<any>('SELECT id,username,is_admin,totp_enabled,created_at FROM users ORDER BY id').map((u) => ({ ...publicUser(u), createdAt: u.created_at })));
  app.delete('/api/admin/users/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    if (id === (req as any).user.id) return reply.code(400).send({ error: 'Du kannst dich nicht selbst löschen' });
    run('DELETE FROM users WHERE id=?', id);
    return { ok: true };
  });
  app.post('/api/admin/users/:id/reset-2fa', async (req) => {
    run("UPDATE users SET totp_enabled=0, totp_secret=NULL, recovery_codes='[]' WHERE id=?", Number((req.params as any).id));
    return { ok: true };
  });
  app.get('/api/admin/invites', async () => all('SELECT code,created_at FROM invites WHERE used_by IS NULL AND created_at>? ORDER BY created_at DESC', new Date(Date.now() - 7 * 86400_000).toISOString()));
  app.post('/api/admin/invites', async (req) => {
    const code = randomBytes(9).toString('base64url');
    run('INSERT INTO invites(code,created_by,created_at) VALUES(?,?,?)', code, (req as any).user.id, nowIso());
    return { code };
  });
  app.delete('/api/admin/invites/:code', async (req) => {
    run('DELETE FROM invites WHERE code=?', String((req.params as any).code));
    return { ok: true };
  });
}
