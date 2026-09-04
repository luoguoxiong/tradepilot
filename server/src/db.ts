import Database from 'better-sqlite3';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// DB_PATH 环境变量可覆盖数据库位置（测试隔离用）
const dbPath = process.env.DB_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data.db');
export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS profiles(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  product_desc TEXT DEFAULT '',
  keywords TEXT DEFAULT '',
  markets TEXT DEFAULT '',
  advantages TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS leads(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  company_name TEXT DEFAULT '',
  domain TEXT DEFAULT '',
  source_url TEXT DEFAULT '',
  source_query TEXT DEFAULT '',
  snippet TEXT DEFAULT '',
  status TEXT DEFAULT 'new',       -- new|queued|scraping|analyzing|done|failed|confirmed
  score REAL,
  grade TEXT,
  error TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  data_json TEXT NOT NULL,
  scraped_pages_json TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS emails(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL,
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  word_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

-- ===== 二期：订单跟单（order-followup）=====
CREATE TABLE IF NOT EXISTS order_imports(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_name TEXT DEFAULT '',
  source_type TEXT DEFAULT 'upload',   -- upload|paste|manual
  parsed_json TEXT DEFAULT '',
  error TEXT,
  status TEXT DEFAULT 'parsed',        -- parsed|confirmed|discarded
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  customer_email TEXT DEFAULT '',
  order_date TEXT DEFAULT '',
  delivery_date TEXT DEFAULT '',
  incoterms TEXT DEFAULT '',
  payment_terms TEXT DEFAULT '',
  currency TEXT DEFAULT 'USD',
  total_amount REAL DEFAULT 0,
  status TEXT DEFAULT 'active',        -- active|closed|cancelled
  remarks TEXT DEFAULT '',
  source_type TEXT DEFAULT 'manual',   -- upload|paste|manual
  source_file_name TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  name TEXT DEFAULT '',
  model TEXT DEFAULT '',
  qty REAL DEFAULT 0,
  unit TEXT DEFAULT '',
  unit_price REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  sort INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS order_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  node TEXT NOT NULL,
  event_date TEXT DEFAULT '',
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_docs(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  doc_type TEXT NOT NULL,              -- pi|invoice|pl
  doc_no TEXT DEFAULT '',
  version INTEGER DEFAULT 1,
  data_json TEXT DEFAULT '',
  html TEXT DEFAULT '',
  overrides_json TEXT,
  note TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS order_mails(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  kind TEXT DEFAULT 'progress',        -- progress|chase|custom
  to_addr TEXT DEFAULT '',
  subject TEXT DEFAULT '',
  body TEXT DEFAULT '',
  status TEXT DEFAULT 'draft',         -- draft|sent|failed
  error TEXT,
  sent_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS reminders(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL,
  type TEXT NOT NULL,                  -- due_soon|overdue|deposit_pending|stalled
  message TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS settings(
  key TEXT PRIMARY KEY,
  value_json TEXT DEFAULT ''
);
`);

export interface Profile {
  id: number; name: string; product_desc: string; keywords: string;
  markets: string; advantages: string; created_at: string;
}
export interface Lead {
  id: number; profile_id: number; company_name: string; domain: string;
  source_url: string; source_query: string; snippet: string; status: string;
  score: number | null; grade: string | null; error: string | null;
  created_at: string; updated_at: string;
}

// ===== 二期：订单跟单 =====
export interface Order {
  id: number; order_no: string; customer_name: string; customer_email: string;
  order_date: string; delivery_date: string; incoterms: string; payment_terms: string;
  currency: string; total_amount: number; status: string; remarks: string;
  source_type: string; source_file_name: string; created_at: string; updated_at: string;
}
export interface OrderItem {
  id?: number; order_id?: number; name: string; model: string;
  qty: number; unit: string; unit_price: number; amount: number; sort?: number;
}
export interface OrderEvent {
  id: number; order_id: number; node: string; event_date: string;
  note: string; created_at: string;
}

/** settings 表读写（值统一 JSON 序列化） */
export function getSetting<T>(key: string): T | null {
  const row = db.prepare('SELECT value_json FROM settings WHERE key=?').get(key) as any;
  if (!row?.value_json) return null;
  try { return JSON.parse(row.value_json) as T; } catch { return null; }
}
export function setSetting(key: string, value: unknown): void {
  db.prepare(`INSERT INTO settings(key, value_json) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json`)
    .run(key, JSON.stringify(value));
}

export const touch = db.prepare(`UPDATE leads SET updated_at = datetime('now') WHERE id = ?`);
export const touchOrder = db.prepare(`UPDATE orders SET updated_at = datetime('now') WHERE id = ?`);
