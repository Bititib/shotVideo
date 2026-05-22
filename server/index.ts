import { env } from './config/env.js';
import { initDatabase } from './db/seed.js';
import { createApp } from './app.js';

async function main() {
  console.log('🚀 正在启动服务器...');

  // 初始化数据库
  await initDatabase();

  // 创建 Express 应用
  const app = await createApp();

  // 启动
  app.listen(env.PORT, '0.0.0.0', () => {
    console.log(`✅ 服务器运行于 http://localhost:${env.PORT}`);
    console.log(`📦 环境: ${env.NODE_ENV}`);
  });
}

main().catch(err => {
  console.error('❌ 启动失败:', err);
  process.exit(1);
});
