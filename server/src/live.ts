import type { FastifyInstance } from 'fastify';
import type { ServerResponse } from 'node:http';

/** Live-Abgleich: Jede Änderung wird als Themenname an alle offenen Geräte gemeldet (Server-Sent Events). Die Geräte laden das Thema dann neu. */
const clients = new Set<ServerResponse>();

export function broadcast(topic: string) {
  for (const c of clients) c.write(`data: ${topic}\n\n`);
}

export function registerLive(app: FastifyInstance) {
  app.get('/api/events', (req, reply) => {
    if (clients.size >= 200) return reply.code(503).send({ error: 'Zu viele Verbindungen' });
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store, no-transform',
      'X-Accel-Buffering': 'no', // Reverse-Proxys sollen nicht puffern
      'X-Content-Type-Options': 'nosniff',
      'X-Vorrat': '1',
    });
    res.write('retry: 5000\n\n');
    clients.add(res);
    req.raw.on('close', () => clients.delete(res));
  });
  // Lebenszeichen, damit Proxys die stille Verbindung nicht kappen
  setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25_000);

  app.addHook('onResponse', async (req, reply) => {
    if (req.method === 'GET' || reply.statusCode >= 400) return;
    const m = req.url.match(/^\/api\/(items|recipes|plan|shopping|settings|admin)\b/);
    if (m) broadcast(m[1]);
  });
}
