import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { registerAi } from './ai.ts';
import { registerApi } from './api.ts';
import { registerAuth } from './auth.ts';
import { registerLive } from './live.ts';
import { registerPush } from './push.ts';

// Hinter dem Reverse-Proxy: X-Forwarded-* auswerten (TRUST_PROXY=false, falls direkt am Netz)
const app = Fastify({ trustProxy: process.env.TRUST_PROXY !== 'false', bodyLimit: 1_000_000, logger: { level: process.env.LOG_LEVEL || 'warn' } });

await app.register(cookie);
await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });

const CSP = [
  "default-src 'self'", "script-src 'self' 'wasm-unsafe-eval'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://*.openfoodfacts.org", "connect-src 'self'", "worker-src 'self'", "manifest-src 'self'",
  "object-src 'none'", "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');
app.addHook('onSend', async (req, reply) => {
  reply.header('Content-Security-Policy', CSP);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Vorrat', '1'); // Kennung: Antwort kommt von der App, nicht von einer vorgeschalteten Login-Seite
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Permissions-Policy', 'camera=(self), microphone=(), geolocation=()');
  reply.header('Cross-Origin-Opener-Policy', 'same-origin');
  if (req.protocol === 'https') reply.header('Strict-Transport-Security', 'max-age=31536000');
  if (req.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
});

// CSRF-Schutz zusätzlich zu SameSite=Lax: schreibende Anfragen nur vom eigenen Ursprung
app.addHook('onRequest', async (req, reply) => {
  if (req.method === 'GET' || req.method === 'HEAD') return;
  const origin = req.headers.origin;
  if (origin) {
    let host = '';
    try { host = new URL(origin).host; } catch { /* ungültig */ }
    if (host !== req.host) return reply.code(403).send({ error: 'Fremder Ursprung' });
  }
});

registerAuth(app);
registerApi(app);
registerAi(app);
registerPush(app);
registerLive(app);

const webRoot = resolve(process.env.WEB_ROOT || '../web/dist');
if (existsSync(webRoot)) {
  await app.register(fstatic, {
    root: webRoot,
    setHeaders(res, path) {
      // Gehashte Assets dürfen ewig gecacht werden, der Rest (index.html, sw.js) nie
      res.setHeader('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
    reply.code(404).send({ error: 'Nicht gefunden' });
  });
}

await app.listen({ port: Number(process.env.PORT || 8080), host: '0.0.0.0' });
console.log(`Vorrat läuft auf Port ${process.env.PORT || 8080}`);
