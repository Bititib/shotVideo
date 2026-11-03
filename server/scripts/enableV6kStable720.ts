import { enableV6kStable720Entry } from '../services/v6kStable720Catalog.js';

let database: import('better-sqlite3').Database | undefined;
try {
  // A chained deployment may return before startup migrations have completed.
  const deadline = Date.now() + 60_000;
  let ready = false;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/api/health', { signal: AbortSignal.timeout(2000) });
      ready = response.ok; await response.body?.cancel();
      if (ready) break;
    } catch { /* Wait for this container's own server, without touching the database. */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  if (!ready) throw new Error('服务尚未就绪，未修改模型配置；请待启动完成后重试');
  database = (await import('../db/index.js')).sqlite;
  console.log(JSON.stringify(await enableV6kStable720Entry(database, Number(process.argv[2])), null, 2));
} catch (error: any) {
  console.error('开启失败：' + error.message); process.exitCode = 1;
} finally { database?.close(); }
