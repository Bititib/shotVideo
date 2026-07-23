import { db } from '../server/db/index.js';
import { initDatabase } from '../server/db/seed.js';
import { models, settings, channels } from '../server/db/schema.js';
import { eq, like, and } from 'drizzle-orm';
import { getVideoConfig, getModelRate } from '../server/services/videoConfigService.js';
import { AdminService } from '../server/services/adminService.js';

async function runDemo() {
  console.log('=== [演示：后台修改系统设置 & 新增模型 -> 前台实时生效] ===\n');
  await initDatabase();

  // 1. 修改前的价格
  const modelId = 'sdas-xh-sd2.0-fast-933-720p';
  console.log('📍 1️⃣ 修改前：');
  console.log(`   模型 [${modelId}] 的 720p 当前费率: ¥${getModelRate(modelId, '720p')} 元/次\n`);

  // 2. 模拟管理员在后台修改费率（降价到 2.20 元/次）
  console.log('📍 2️⃣ 模拟管理员在后台面板修改费率：将价格调至 ¥2.20 元/次...');
  AdminService.updateSettings([
    { key: 'sdas_xh_sd20_fast_933_720p_rate', value: '2.20' }
  ]);
  console.log(`   ✨ 实时生效！前台再次读取该模型费率: ¥${getModelRate(modelId, '720p')} 元/次\n`);

  // 3. 模拟管理员在后台新增一个全新模型
  const newModelId = 'sdas-pd-sd2.0-fast-933-3-720p';
  console.log(`📍 3️⃣ 模拟管理员在后台新建全新模型 [${newModelId}] (无需修改任何系统代码)...`);
  
  // 清理如果存在的旧数据
  db.delete(models).where(eq(models.modelId, newModelId)).run();

  AdminService.createModel({
    provider: 'sudashui',
    modelId: newModelId,
    displayName: 'Seedance 2.0 PD Fast 720p',
    capabilities: ['video'],
    videoConfig: {
      series: 'sudashui',
      allowedSeconds: [10, 15],
      requireRef: false,
      maxSeconds: 15,
      billingType: 'per_second',
      rateSettingKey: 'sdas_pd_fast_rate',
      defaultRate: 0.25,
      description: '新增模型上线 (0.25元/秒)',
      icon: '⚡',
      group: 'Seedance 系列'
    }
  });

  // 将新模型绑定到支持它的渠道
  const ch = db.select().from(channels).where(like(channels.baseUrl, '%sudashuiapi.com%')).get();
  if (ch) {
    let currentModels: string[] = JSON.parse(ch.supportedModels || '[]');
    if (!currentModels.includes(newModelId)) {
      currentModels.push(newModelId);
      db.update(channels).set({ supportedModels: JSON.stringify(currentModels) }).where(eq(channels.id, ch.id)).run();
    }
  }

  // 4. 模拟前端打开/刷新页面拉取到的模型列表 (GET /api/video/models)
  console.log('📍 4️⃣ 模拟前端用户刷新页面（请求 /api/video/models 接口获取到的 Seedance 系列模型）：');
  const allDbModels = db.select().from(models)
    .where(and(eq(models.isActive, 1), like(models.capabilities, '%"video"%')))
    .all();

  const seedanceGroupModels = allDbModels
    .map(m => {
      const cfg = getVideoConfig(m.modelId);
      return {
        '模型ID': m.modelId,
        '显示名称': m.displayName,
        '计费模式': cfg?.billingType === 'flat' ? '按次计费' : '按秒计费',
        '前台显示价格': `¥${getModelRate(m.modelId, '720p')}${cfg?.billingType === 'flat' ? '/次' : '/秒'}`,
        '所属分组': cfg?.group
      };
    })
    .filter(m => m['所属分组'] === 'Seedance 系列');

  console.table(seedanceGroupModels);

  // 清理测试用的新增模型并恢复设置
  db.delete(models).where(eq(models.modelId, newModelId)).run();
  AdminService.updateSettings([{ key: 'sdas_xh_sd20_fast_933_720p_rate', value: '2.50' }]);
  console.log('\n=== [演示结束，已恢复原环境数据] ===');
}

runDemo().catch(console.error);
