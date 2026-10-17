import { migrate, pool } from './db.js';

await migrate();
console.log('テーブルを作成しました');
await pool.end();
