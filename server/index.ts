import { migrateZonghengModelPrefix } from './services/zonghengPrefixMigration.js';
import { retireBlobDrawChannels } from './services/blobDrawRetirementMigration.js';
import { env } from './config/env.js';
import { initDatabase } from './db/seed.js';
import { createApp } from './app.js';

async function main() {
  console.log('🚀 正在启动服务器...');

  // 初始化数据库
  await initDatabase();
  migrateZonghengModelPrefix();
  const retiredChannels = retireBlobDrawChannels();
  if (retiredChannels) console.log(`已将 ${retiredChannels} 个 BlobDraw 渠道切换为待配置的 HUSS 渠道`);

  // 创建 Express 应用
  const app = await createApp();

  // 启动
  app.listen(env.PORT, '0.0.0.0', async () => {
    console.log(`✅ 服务器运行于 http://localhost:${env.PORT}`);
    console.log(`📦 环境: ${env.NODE_ENV}`);

    const { startVideoBatchWorker } = await import('./services/videoBatchService.js');
    startVideoBatchWorker();
    const { resumePidoiImages } = await import('./services/pidoiImageWorker.js');
    void resumePidoiImages().catch(error => console.error('[pidoi-image-recover]', error.message));
    setInterval(() => { void resumePidoiImages().catch(error => console.error('[pidoi-image-recover]', error.message)); }, 10_000);

    // 监听端口后再恢复队列，确保 HM 能访问本站托管的参考素材。
    try {
      const { resumeAllPendingVideoTasks } = await import('./routes/video.js');
      resumeAllPendingVideoTasks();
      setInterval(() => {
        resumeAllPendingVideoTasks();
      }, 60_000);
      const { ComicDramaQueueService } = await import('./services/comicDramaQueueService.js');
      ComicDramaQueueService.resumePending();
      setInterval(() => ComicDramaQueueService.resumePending(), 60_000);
    } catch (e: any) {
      console.error('⚠️ [video-recover] 恢复视频任务失败:', e.message);
    }
  });
}

main().catch(err => {
  console.error('❌ 启动失败:', err);
  process.exit(1);
});
