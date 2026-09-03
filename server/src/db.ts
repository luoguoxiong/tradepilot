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

export const touch = db.prepare(`UPDATE leads SET updated_at = datetime('now') WHERE id = ?`);
