// 1回分の収集を実行して終了する（Render の Cron Job などから呼ぶ用）
import { migrate, pool } from './db.js';
import { runCollection } from './collect.js';

try {
  await migrate();
  const r = await runCollection();
  console.log(JSON.stringify(r));
} catch (e) {
  console.error(e);
  process.exitCode = 1;
} finally {
  await pool.end();
}
