const Database = require('better-sqlite3');
const path = require('path');

const dbPath = path.join(process.cwd(), 'data', 'app.db');
const db = new Database(dbPath);

console.log('开始同步清理数据库中的废弃模型...');

// 1. 下架的模型列表
const deprecatedModelIds = [
  'sdas-xh-sd2.0-fast-933-720p',
  'sdas-xh-sd2.0-pro-933-720p',
  'sd2-c6'
];

// 删除 models 表中的记录
for (const modelId of deprecatedModelIds) {
  const result = db.prepare('DELETE FROM models WHERE model_id = ?').run(modelId);
  console.log(`[models] 删除 ${modelId}: 影响 ${result.changes} 行`);
}

// 删除 settings 表中的费率配置记录
const deprecatedSettingsKeys = [
  'sdas_xh_sd20_fast_933_720p_rate',
  'sdas_xh_sd20_pro_933_720p_rate',
  'sd2_c6_rate'
];

for (const key of deprecatedSettingsKeys) {
  const result = db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  console.log(`[settings] 删除费率 ${key}: 影响 ${result.changes} 行`);
}

// 2. 插入或确保新模型 sdas-xh-sd2.0-933-3-pro-720p 存在于 models 表
const newModelId = 'sdas-xh-sd2.0-933-3-pro-720p';
const existingNewModel = db.prepare('SELECT * FROM models WHERE model_id = ?').get(newModelId);

if (!existingNewModel) {
  db.prepare(`
    INSERT INTO models (provider, model_id, display_name, capabilities, is_active)
    VALUES (?, ?, ?, ?, 1)
  `).run('sudashui', newModelId, 'Seedance 2.0 Pro 933-3 (720p)', JSON.stringify(['video']));
  console.log(`[models] 成功添加新模型 ${newModelId}`);
} else {
  console.log(`[models] 新模型 ${newModelId} 已存在`);
}

// 确保费率设置 sdas_xh_sd20_933_3_pro_720p_rate 存在并设为 4.50
const existingRate = db.prepare('SELECT * FROM settings WHERE key = ?').get('sdas_xh_sd20_933_3_pro_720p_rate');
if (!existingRate) {
  db.prepare(`
    INSERT INTO settings (key, value, label)
    VALUES (?, ?, ?)
  `).run('sdas_xh_sd20_933_3_pro_720p_rate', '4.50', 'Seedance 2.0 Pro 933-3 (720p) 费率(¥/次)');
  console.log('[settings] 成功创建费率配置 sdas_xh_sd20_933_3_pro_720p_rate = 4.50');
} else {
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run('4.50', 'sdas_xh_sd20_933_3_pro_720p_rate');
  console.log('[settings] 更新费率配置 sdas_xh_sd20_933_3_pro_720p_rate = 4.50');
}

// 3. 更新渠道 channels 表中包含废弃模型的 supported_models 字段
const channels = db.prepare('SELECT id, name, supported_models FROM channels').all();
for (const ch of channels) {
  try {
    let modelsList = JSON.parse(ch.supported_models || '[]');
    let modified = false;
    
    // 过滤掉下架的模型
    const newModelsList = modelsList.filter(m => !deprecatedModelIds.includes(m));
    if (newModelsList.length !== modelsList.length) {
      modified = true;
    }

    // 如果渠道包含速水/速大师，确保添加新模型
    if (ch.name.includes('速大师') || ch.name.includes('星河') || ch.supported_models.includes('sdas')) {
      if (!newModelsList.includes(newModelId)) {
        newModelsList.push(newModelId);
        modified = true;
      }
    }

    if (modified) {
      db.prepare('UPDATE channels SET supported_models = ? WHERE id = ?').run(JSON.stringify(newModelsList), ch.id);
      console.log(`[channels] 已更新渠道 ID ${ch.id} (${ch.name}) 支持的模型列表`);
    }
  } catch (e) {
    console.error(`[channels] 处理渠道 ID ${ch.id} 失败:`, e.message);
  }
}

db.close();
console.log('数据库清理与同步完成！');
