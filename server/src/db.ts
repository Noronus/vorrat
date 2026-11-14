import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';

export const DATA_DIR = process.env.DATA_DIR || './data';
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(`${DATA_DIR}/vorrat.db`);

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  recovery_codes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  user_agent TEXT
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  used_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS locations (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products (
  barcode TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  package_amount REAL,
  unit TEXT,
  image_url TEXT,
  source TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  brand TEXT,
  barcode TEXT,
  image_url TEXT,
  location_id INTEGER REFERENCES locations(id) ON DELETE SET NULL,
  unit TEXT NOT NULL DEFAULT 'Stk',
  package_amount REAL NOT NULL DEFAULT 1,
  count INTEGER NOT NULL DEFAULT 1,
  remaining_amount REAL NOT NULL DEFAULT 1,
  expires_on TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  consumed_at TEXT
);
CREATE INDEX IF NOT EXISTS items_active ON items(consumed_at, expires_on);
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  servings INTEGER,
  time_minutes INTEGER,
  ingredients TEXT NOT NULL DEFAULT '[]',
  steps TEXT NOT NULL DEFAULT '[]',
  source TEXT NOT NULL DEFAULT 'manual',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meal_plan (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  slot TEXT NOT NULL DEFAULT 'Abend',
  recipe_id INTEGER REFERENCES recipes(id) ON DELETE SET NULL,
  title TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS plan_date ON meal_plan(date);
CREATE TABLE IF NOT EXISTS shopping_items (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  amount TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  added_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS push_subs (
  endpoint TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sub TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_jobs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  params TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  result TEXT,
  error TEXT,
  created_at TEXT NOT NULL
);
`);

for (const sql of [
  'ALTER TABLE users ADD COLUMN totp_last_step INTEGER',
  'ALTER TABLE items ADD COLUMN category TEXT',
  'ALTER TABLE products ADD COLUMN category TEXT',
  'ALTER TABLE users ADD COLUMN prefs TEXT',
  'ALTER TABLE items ADD COLUMN tags TEXT',
  'ALTER TABLE shopping_items ADD COLUMN item_id INTEGER',
  'ALTER TABLE shopping_items ADD COLUMN stocked_item_id INTEGER',
  'ALTER TABLE shopping_items ADD COLUMN stocked_amount REAL',
  'ALTER TABLE recipes ADD COLUMN step_ingredients TEXT',
  'ALTER TABLE recipes ADD COLUMN emoji TEXT',
  'ALTER TABLE shopping_items ADD COLUMN pack_amount REAL',
]) { try { db.exec(sql); } catch { /* Spalte existiert schon */ } }

type P = string | number | bigint | null | undefined | boolean;
const norm = (p: P[]) =>
  p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v)) as (string | number | bigint | null)[];

export const all = <T = any>(sql: string, ...p: P[]): T[] => db.prepare(sql).all(...norm(p)) as T[];
export const get = <T = any>(sql: string, ...p: P[]): T | undefined => db.prepare(sql).get(...norm(p)) as T | undefined;
export const run = (sql: string, ...p: P[]) => db.prepare(sql).run(...norm(p));

export const getSetting = (key: string, def = ''): string =>
  get<{ value: string }>('SELECT value FROM settings WHERE key=?', key)?.value ?? def;
export const setSetting = (key: string, value: string) =>
  run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, value);

export const nowIso = () => new Date().toISOString();
/** Lokales Datum (TZ des Prozesses) als YYYY-MM-DD */
export const today = (offsetDays = 0) => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toLocaleDateString('sv-SE');
};

run("UPDATE ai_jobs SET status='error', error='Server wurde neu gestartet' WHERE status='running'");
