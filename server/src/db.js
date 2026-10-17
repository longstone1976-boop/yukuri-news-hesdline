import pg from 'pg';
import { readFile } from 'node:fs/promises';

const { Pool } = pg;

if (!process.env.DATABASE_URL) {
  throw new Error('環境変数 DATABASE_URL が設定されていません');
}

// Render などのマネージドDBはSSL接続。ローカルの場合は DATABASE_SSL=false にする
const ssl = process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false };

export const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl, max: 5 });

export async function migrate() {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}
