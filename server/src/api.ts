import type { FastifyInstance } from 'fastify';
import { all, get, getSetting, nowIso, run, setSetting } from './db.ts';
import { scheduleTagging } from './ai.ts';
import { broadcast } from './live.ts';
import { reminderPayload } from './push.ts';

const UNITS = ['g', 'ml', 'Stk', '%'];
const str = (v: unknown, max = 200) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() && isFinite(Number(v.replace(',', '.'))) ? Number(v.replace(',', '.')) : null);
const date = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
const httpsUrl = (v: unknown) => { const s = str(v, 500); return s && /^https:\/\/[^\s"'<>]+$/.test(s) ? s : null; };
const uid = (req: any) => req.user.id as number;

// ---------- Open Food Facts ----------
function normalizeQty(amount: number | null, unit: string | null): { amount: number | null; unit: string | null } {
  if (amount == null || !unit) return { amount: null, unit: null };
  const u = unit.toLowerCase();
  if (u === 'g') return { amount, unit: 'g' };
  if (u === 'kg') return { amount: amount * 1000, unit: 'g' };
  if (u === 'mg') return { amount: amount / 1000, unit: 'g' };
  if (u === 'ml') return { amount, unit: 'ml' };
  if (u === 'cl') return { amount: amount * 10, unit: 'ml' };
  if (u === 'dl') return { amount: amount * 100, unit: 'ml' };
  if (u === 'l') return { amount: amount * 1000, unit: 'ml' };
  return { amount: null, unit: null };
}

async function lookupOff(barcode: string) {
  const url = `https://world.openfoodfacts.org/api/v2/product/${barcode}.json?fields=product_name,product_name_de,brands,quantity,product_quantity,product_quantity_unit,categories_tags`;
  const res = await fetch(url, { headers: { 'User-Agent': 'Vorrat/1.0 (self-hosted pantry app)' }, signal: AbortSignal.timeout(8000) });
  if (!res.ok) return null;
  const j: any = await res.json();
  const p = j?.product;
  if (j?.status !== 1 || !p) return null;
  const name = str(p.product_name_de) || str(p.product_name);
  if (!name) return null;
  let q = normalizeQty(num(p.product_quantity), str(p.product_quantity_unit));
  if (q.amount == null && typeof p.quantity === 'string') {
    // z. B. "500 g", "1,5 l", "6 x 330 ml"
    const m = p.quantity.match(/(?:(\d+)\s*[x×]\s*)?([\d.,]+)\s*(kg|mg|g|ml|cl|dl|l)\b/i);
    if (m) {
      q = normalizeQty(Number(m[2].replace(',', '.')) * (m[1] ? Number(m[1]) : 1), m[3]);
    }
  }
  return { barcode, name, brand: str(String(p.brands || '').split(',')[0]), package_amount: q.amount, unit: q.unit, image_url: null, category: (Array.isArray(p.categories_tags) ? p.categories_tags.join(' ') : '').slice(0, 400) || null, source: 'off' };
}

export function registerApi(app: FastifyInstance) {
  app.get('/api/health', async () => ({ ok: true }));

  // ---------- Produkte (Barcode) ----------
  app.get('/api/products/:barcode', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const barcode = String((req.params as any).barcode).replace(/\D/g, '').slice(0, 14);
    if (barcode.length < 6) return { found: false };
    const inStock = all(
      `SELECT i.* FROM items i WHERE i.barcode=? AND i.consumed_at IS NULL ORDER BY i.expires_on`, barcode);
    let product = get<any>('SELECT * FROM products WHERE barcode=?', barcode);
    if (!product) {
      try {
        product = await lookupOff(barcode);
        if (product)
          run('INSERT OR REPLACE INTO products(barcode,name,brand,package_amount,unit,image_url,source,updated_at) VALUES(?,?,?,?,?,?,?,?)',
            barcode, product.name, product.brand, product.package_amount, product.unit, product.image_url, 'off', nowIso());
        if (product) run('UPDATE products SET category=? WHERE barcode=?', product.category, barcode);
      } catch { /* offline oder Timeout: wie nicht gefunden behandeln */ }
    }
    return { found: !!product, barcode, product: product || null, inStock };
  });

  // ---------- Inventar ----------
  const itemSelect = `SELECT i.* FROM items i`;
  app.get('/api/items', async () =>
    all(`${itemSelect} WHERE i.consumed_at IS NULL ORDER BY i.expires_on IS NULL, i.expires_on, i.name COLLATE NOCASE`));

  /** Aufgebrauchtes (je Produkt einmal, zuletzt Geleertes zuerst), solange davon nichts mehr im Vorrat ist */
  app.get('/api/items/empty', async () => {
    const seen = new Set<string>();
    const key = (i: any) => `${i.name}|${i.brand || ''}`.toLowerCase();
    for (const i of all<any>('SELECT name, brand FROM items WHERE consumed_at IS NULL')) seen.add(key(i));
    return all<any>(`${itemSelect} WHERE i.consumed_at IS NOT NULL ORDER BY i.consumed_at DESC`).filter((i) => !seen.has(key(i)) && !!seen.add(key(i)));
  });
  /** Aufgebrauchtes Produkt ganz vergessen (alle leeren Einträge mit gleichem Namen und gleicher Marke) */
  app.delete('/api/items/empty/:id', async (req) => {
    const it = get<any>('SELECT name, brand FROM items WHERE id=? AND consumed_at IS NOT NULL', Number((req.params as any).id));
    if (it) run('DELETE FROM items WHERE consumed_at IS NOT NULL AND name=? AND brand IS ?', it.name, it.brand);
    return { ok: true };
  });

  /** Alles, was je im Vorrat war (je Produkt einmal, Vorhandenes zuerst): Grundlage für die Suche der Einkaufsliste */
  app.get('/api/items/catalog', async () => {
    const seen = new Set<string>();
    return all<any>(`${itemSelect} ORDER BY i.consumed_at IS NOT NULL, i.id DESC`).filter((i) => {
      const key = `${i.name}|${i.brand || ''}`.toLowerCase();
      return !seen.has(key) && !!seen.add(key);
    });
  });

  app.post('/api/items', async (req, reply) => {
    const b = req.body as any;
    const name = str(b.name);
    if (!name) return reply.code(400).send({ error: 'Name fehlt' });
    const unit = UNITS.includes(b.unit) ? b.unit : 'Stk';
    const pkg = Math.max(num(b.package_amount) ?? (unit === '%' ? 100 : 1), 0.001);
    const count = Math.max(1, Math.round(num(b.count) ?? 1));
    const remaining = Math.min(Math.max(num(b.remaining_amount) ?? pkg * count, 0), pkg * count);
    const barcode = str(b.barcode, 20);
    const expires = date(b.expires_on);
    const now = nowIso();

    if (barcode) {
      // Gelernte Produktdaten des Haushalts haben Vorrang vor Open Food Facts
      run('INSERT OR REPLACE INTO products(barcode,name,brand,package_amount,unit,image_url,source,updated_at) VALUES(?,?,?,?,?,?,?,?)',
        barcode, name, str(b.brand), pkg, unit, httpsUrl(b.image_url), 'user', now);
      run('UPDATE products SET category=? WHERE barcode=?', str(b.category, 400), barcode);
      const same = get<any>(
        `SELECT id FROM items WHERE consumed_at IS NULL AND barcode=? AND expires_on IS ? AND package_amount=? AND unit=?`,
        barcode, expires, pkg, unit);
      if (same) {
        run('UPDATE items SET count=count+?, remaining_amount=remaining_amount+?, updated_at=? WHERE id=?', count, remaining, now, same.id);
        return { id: same.id, merged: true };
      }
    }
    const r = run(
      `INSERT INTO items(name,brand,barcode,image_url,unit,package_amount,count,remaining_amount,expires_on,note,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      name, str(b.brand), barcode, httpsUrl(b.image_url), unit, pkg, count, remaining, expires, str(b.note, 500), now, now);
    run('UPDATE items SET category=? WHERE id=?', str(b.category, 400), r.lastInsertRowid);
    scheduleTagging();
    return { id: Number(r.lastInsertRowid) };
  });

  /** Nach dem Kochen: mehrere Mengen auf einmal abziehen */
  app.post('/api/items/consume', async (req) => {
    const list = Array.isArray((req.body as any).deductions) ? (req.body as any).deductions.slice(0, 100) : [];
    const used: string[] = [];
    let changed = 0;
    for (const d of list) {
      const cur = get<any>('SELECT * FROM items WHERE id=? AND consumed_at IS NULL', Number(d?.id));
      const amount = num(d?.amount);
      if (!cur || amount == null || amount <= 0) continue;
      const remaining = Math.max(Math.round((cur.remaining_amount - amount) * 100) / 100, 0);
      const count = Math.max(1, Math.ceil(remaining / cur.package_amount - 1e-9));
      run('UPDATE items SET remaining_amount=?, count=?, consumed_at=?, updated_at=? WHERE id=?', remaining, count, remaining <= 0 ? nowIso() : null, nowIso(), cur.id);
      changed++;
      if (remaining <= 0) used.push(cur.name);
    }
    return { changed, usedUp: used };
  });

  app.patch('/api/items/:id', async (req, reply) => {
    const id = Number((req.params as any).id);
    const cur = get<any>('SELECT * FROM items WHERE id=?', id);
    if (!cur) return reply.code(404).send({ error: 'Nicht gefunden' });
    const b = req.body as any;
    const n = { ...cur };
    if ('name' in b) n.name = str(b.name) || cur.name;
    if ('brand' in b) n.brand = str(b.brand);
    if ('note' in b) n.note = str(b.note, 500);
    if ('expires_on' in b) n.expires_on = date(b.expires_on);
    if ('unit' in b && UNITS.includes(b.unit)) n.unit = b.unit;
    if ('package_amount' in b) n.package_amount = Math.max(num(b.package_amount) ?? cur.package_amount, 0.001);
    if ('count' in b) n.count = Math.max(1, Math.round(num(b.count) ?? cur.count));
    if ('remaining_amount' in b) n.remaining_amount = num(b.remaining_amount) ?? cur.remaining_amount;
    n.remaining_amount = Math.min(Math.max(n.remaining_amount, 0), n.package_amount * n.count);
    // Anzahl Packungen an den Rest anpassen: 1,5 Packungen übrig -> 2 Packungen
    if ('remaining_amount' in b && !('count' in b)) n.count = Math.max(1, Math.ceil(n.remaining_amount / n.package_amount - 1e-9));
    const consumed = n.remaining_amount <= 0 ? nowIso() : null;
    run(`UPDATE items SET name=?,brand=?,note=?,expires_on=?,unit=?,package_amount=?,count=?,remaining_amount=?,consumed_at=?,updated_at=? WHERE id=?`,
      n.name, n.brand, n.note, n.expires_on, n.unit, n.package_amount, n.count, n.remaining_amount, consumed, nowIso(), id);
    if (n.name !== cur.name) { run('UPDATE items SET tags=NULL WHERE id=?', id); scheduleTagging(); }
    return { ok: true, consumed: !!consumed };
  });

  app.delete('/api/items/:id', async (req) => {
    run('DELETE FROM items WHERE id=?', Number((req.params as any).id));
    return { ok: true };
  });

  // ---------- Rezepte ----------
  const recipeOut = (r: any) => r && { ...r, ingredients: JSON.parse(r.ingredients), steps: JSON.parse(r.steps), step_ingredients: r.step_ingredients ? JSON.parse(r.step_ingredients) : null };
  const recipeIn = (b: any) => ({
    title: str(b.title),
    description: str(b.description, 2000),
    servings: num(b.servings),
    time_minutes: num(b.time_minutes),
    ingredients: JSON.stringify((Array.isArray(b.ingredients) ? b.ingredients : []).slice(0, 80)
      .map((i: any) => ({ name: str(i?.name) || '', amount: str(i?.amount, 60) || '' })).filter((i: any) => i.name)),
    steps: JSON.stringify((Array.isArray(b.steps) ? b.steps : []).slice(0, 60).map((s: any) => str(s, 2000)).filter(Boolean)),
    // Zutaten je Schritt (Index in ingredients); nur gültig, wenn es zu den Schritten passt
    step_ingredients: Array.isArray(b.step_ingredients) && Array.isArray(b.steps) && b.step_ingredients.length === b.steps.length
      ? JSON.stringify(b.step_ingredients.slice(0, 60).map((l: any) => (Array.isArray(l) ? l : []).map(Number).filter((n: number) => Number.isInteger(n) && n >= 0 && n < 80).slice(0, 30)))
      : null,
    emoji: str(b.emoji, 8),
  });
  app.get('/api/recipes', async () => all('SELECT * FROM recipes ORDER BY title COLLATE NOCASE').map(recipeOut));
  app.post('/api/recipes', async (req, reply) => {
    const r = recipeIn(req.body);
    if (!r.title) return reply.code(400).send({ error: 'Titel fehlt' });
    const existing = get<any>('SELECT id FROM recipes WHERE title=? COLLATE NOCASE', r.title);
    if (existing && (req.body as any).dedupe) return { id: existing.id, existed: true };
    const res = run('INSERT INTO recipes(title,description,servings,time_minutes,ingredients,steps,step_ingredients,emoji,source,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      r.title, r.description, r.servings, r.time_minutes, r.ingredients, r.steps, r.step_ingredients, r.emoji, (req.body as any).source === 'ai' ? 'ai' : 'manual', uid(req), nowIso());
    return { id: Number(res.lastInsertRowid) };
  });
  app.put('/api/recipes/:id', async (req, reply) => {
    const r = recipeIn(req.body);
    if (!r.title) return reply.code(400).send({ error: 'Titel fehlt' });
    run('UPDATE recipes SET title=?,description=?,servings=?,time_minutes=?,ingredients=?,steps=?,step_ingredients=?,emoji=COALESCE(?,emoji) WHERE id=?',
      r.title, r.description, r.servings, r.time_minutes, r.ingredients, r.steps, r.step_ingredients, r.emoji, Number((req.params as any).id));
    return { ok: true };
  });
  app.delete('/api/recipes/:id', async (req) => {
    run('DELETE FROM recipes WHERE id=?', Number((req.params as any).id));
    return { ok: true };
  });

  // ---------- Essensplan ----------
  app.get('/api/plan', async (req) => {
    const q = req.query as any;
    return all('SELECT * FROM meal_plan WHERE date>=? AND date<=? ORDER BY date, CASE slot WHEN \'Frühstück\' THEN 0 WHEN \'Mittag\' THEN 1 ELSE 2 END, id',
      date(q.from) || '0000-00-00', date(q.to) || '9999-99-99');
  });
  app.post('/api/plan', async (req, reply) => {
    const b = req.body as any;
    const d = date(b.date);
    const recipeId = num(b.recipe_id);
    const title = str(b.title) || (recipeId ? get<any>('SELECT title FROM recipes WHERE id=?', recipeId)?.title : null);
    if (!d || !title) return reply.code(400).send({ error: 'Datum oder Titel fehlt' });
    const r = run('INSERT INTO meal_plan(date,slot,recipe_id,title) VALUES(?,?,?,?)', d, str(b.slot, 20) || 'Abend', recipeId, title);
    return { id: Number(r.lastInsertRowid) };
  });
  app.delete('/api/plan/:id', async (req) => {
    run('DELETE FROM meal_plan WHERE id=?', Number((req.params as any).id));
    return { ok: true };
  });

  // ---------- Einkaufsliste ----------
  app.get('/api/shopping', async () => all(
    `SELECT s.*, i.unit, COALESCE(s.pack_amount, i.package_amount) AS package_amount, i.category, i.brand FROM shopping_items s LEFT JOIN items i ON i.id=s.item_id ORDER BY s.done, s.id DESC`));

  /** Abgehakt = gekauft: eine volle Packung kommt in den Vorrat. Liefert die Nummer des Vorrats-Eintrags. */
  function stock(src: any, amount = src.package_amount): number {
    const now = nowIso();
    // Ohne Ablaufdatum und bei gleicher Packungsgröße zählt die neue Packung zum vorhandenen Eintrag,
    // sonst wird es ein eigener (anderes Datum oder andere Größe)
    if (!src.consumed_at && !src.expires_on && amount === src.package_amount) {
      run('UPDATE items SET count=count+1, remaining_amount=remaining_amount+?, updated_at=? WHERE id=?', src.package_amount, now, src.id);
      return src.id;
    }
    const r = run(
      `INSERT INTO items(name,brand,barcode,image_url,unit,package_amount,count,remaining_amount,category,tags,created_at,updated_at)
       VALUES(?,?,?,?,?,?,1,?,?,?,?,?)`,
      src.name, src.brand, src.barcode, src.image_url, src.unit, amount, amount, src.category, src.tags, now, now);
    return Number(r.lastInsertRowid);
  }
  /** Haken wieder entfernt: die Packung geht wieder aus dem Vorrat */
  function unstock(s: any) {
    const it = get<any>('SELECT * FROM items WHERE id=? AND consumed_at IS NULL', s.stocked_item_id);
    if (!it) return;
    const remaining = Math.max(Math.round((it.remaining_amount - s.stocked_amount) * 100) / 100, 0);
    if (remaining > 0) run('UPDATE items SET remaining_amount=?, count=?, updated_at=? WHERE id=?', remaining, Math.max(1, it.count - 1), nowIso(), it.id);
    else if (it.id !== s.item_id) run('DELETE FROM items WHERE id=?', it.id);
    else run('UPDATE items SET remaining_amount=0, consumed_at=?, updated_at=? WHERE id=?', nowIso(), nowIso(), it.id);
  }
  app.post('/api/shopping', async (req, reply) => {
    const b = req.body as any;
    const list: any[] = Array.isArray(b.items) ? b.items : [b];
    let added = 0;
    for (const it of list.slice(0, 100)) {
      const name = str(it?.name);
      if (!name) continue;
      if (get('SELECT 1 FROM shopping_items WHERE done=0 AND name=? COLLATE NOCASE', name)) continue;
      // Verknüpfung zum Vorrat: ausdrücklich gewählt oder über den gleichen Namen (auch Aufgebrauchtes)
      const linked = get<any>('SELECT id FROM items WHERE id=?', Number(it.item_id))
        || get<any>('SELECT id FROM items WHERE name=? COLLATE NOCASE ORDER BY consumed_at IS NOT NULL, id DESC LIMIT 1', name);
      run('INSERT INTO shopping_items(name,amount,added_by,created_at,item_id) VALUES(?,?,?,?,?)', name, str(it.amount, 60), uid(req), nowIso(), linked?.id ?? null);
      added++;
    }
    if (!added && list.length === 1 && !str(list[0]?.name)) return reply.code(400).send({ error: 'Name fehlt' });
    return { added };
  });
  app.patch('/api/shopping/:id', async (req) => {
    const b = req.body as any;
    const id = Number((req.params as any).id);
    const cur = get<any>('SELECT * FROM shopping_items WHERE id=?', id);
    let stocked = false;
    if (cur && 'done' in b && !!b.done !== !!cur.done) {
      if (b.done) {
        const src = cur.item_id && get<any>('SELECT * FROM items WHERE id=?', cur.item_id);
        if (src) {
          const amount = cur.pack_amount ?? src.package_amount;
          run('UPDATE shopping_items SET stocked_item_id=?, stocked_amount=? WHERE id=?', stock(src, amount), amount, id);
          stocked = true;
        }
      } else if (cur.stocked_item_id) {
        unstock(cur);
        run('UPDATE shopping_items SET stocked_item_id=NULL, stocked_amount=NULL WHERE id=?', id);
      }
      run('UPDATE shopping_items SET done=? WHERE id=?', b.done ? 1 : 0, id);
      broadcast('items');
    }
    // Packungsgröße für diesen Einkauf (z. B. 750 statt 500 g); null = wie im Vorrat
    if ('pack_amount' in b) {
      const n = Number(b.pack_amount);
      run('UPDATE shopping_items SET pack_amount=? WHERE id=?', n > 0 && n < 1e6 ? Math.round(n * 100) / 100 : null, id);
    }
    if ('name' in b && str(b.name)) run('UPDATE shopping_items SET name=?, amount=? WHERE id=?', str(b.name), str(b.amount, 60), id);
    return { ok: true, stocked };
  });
  app.delete('/api/shopping/:id', async (req) => {
    run('DELETE FROM shopping_items WHERE id=?', Number((req.params as any).id));
    return { ok: true };
  });
  app.post('/api/shopping/clear-done', async () => {
    run('DELETE FROM shopping_items WHERE done=1');
    return { ok: true };
  });

  // ---------- Einstellungen ----------
  app.get('/api/settings', async (req) => ({
    prefs: get<any>('SELECT prefs FROM users WHERE id=?', (req as any).user.id)?.prefs || '',
    aiModel: getSetting('ai_model', 'sonnet'),
    diet: getSetting('diet', 'omnivor'),
    reminderDays: Number(getSetting('reminder_days', '3')),
    reminderHour: Number(getSetting('reminder_hour', '9')),
  }));
  /** Für die Android-App: Sie fragt selbst nach und zeigt die Erinnerung lokal an (kein Google-Push nötig) */
  app.get('/api/reminders', async () => ({ hour: Number(getSetting('reminder_hour', '9')), ...reminderPayload() }));
  // Haushalts-Einstellungen, die jeder ändern darf
  app.put('/api/settings', async (req) => {
    const b = req.body as any;
    if (['omnivor', 'vegetarisch', 'vegan'].includes(b.diet)) setSetting('diet', b.diet);
    if (typeof b.prefs === 'string') run('UPDATE users SET prefs=? WHERE id=?', b.prefs.trim().slice(0, 500), (req as any).user.id);
    return { ok: true };
  });
  app.put('/api/admin/settings', async (req) => {
    const b = req.body as any;
    if (['sonnet', 'haiku'].includes(b.aiModel)) setSetting('ai_model', b.aiModel);
    const d = num(b.reminderDays);
    if (d != null) setSetting('reminder_days', String(Math.min(Math.max(Math.round(d), 0), 30)));
    const h = num(b.reminderHour);
    if (h != null) setSetting('reminder_hour', String(Math.min(Math.max(Math.round(h), 0), 23)));
    if (typeof b.claudeToken === 'string') setSetting('claude_token', b.claudeToken.trim().slice(0, 500));
    return { ok: true };
  });
}
