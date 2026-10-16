import { db, sqlite } from '../db/index.js';
import { models, users } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { ensureUserModelTables } from '../db/userModelMigration.js';
import { PricingService } from './pricingService.js';
import { getModelSpecifications } from './modelRoutingService.js';
import type { UserModelPrice, UserModelSetting } from '../../shared/userModelSettings.js';

const fail = (status: number, message: string): never => { throw Object.assign(new Error(message), { status }); };
const price = (row: any): UserModelPrice | null => row ? {
  billingType: row.billing_type, inputPrice: row.input_price, outputPrice: row.output_price,
  extraParams: JSON.parse(row.extra_params || '{}'), revision: row.revision,
} : null;
function modelKind(capabilities: string): NonNullable<UserModelSetting['kind']> {
  try {
    const values = JSON.parse(capabilities || '[]');
    if (values.includes('video')) return 'video';
    if (values.includes('image') || values.includes('image_gen')) return 'image';
    if (values.includes('tts')) return 'tts';
    if (values.includes('text')) return 'text';
  } catch { /* unclassified models remain editable */ }
  return 'other';
}

export class UserModelSettingsService {
  static list(userId: number): UserModelSetting[] {
    ensureUserModelTables(sqlite);
    if (!Number.isSafeInteger(userId) || !db.select().from(users).where(eq(users.id, userId)).get()) fail(404, '用户不存在');
    const allModels = db.select().from(models).all();
    const defaults = new Map(PricingService.getPublicPricingForModels(allModels.map(m => m.modelId)).map(p => [p.model, {
      billingType: p.billing_type, inputPrice: p.unit_price, outputPrice: p.output_unit_price, extraParams: p.resolution_prices,
    }]));
    const custom = new Map((sqlite.prepare('SELECT * FROM user_model_pricing WHERE user_id=?').all(userId) as any[]).map(p => [p.model_id, price(p)]));
    const access = new Map((sqlite.prepare('SELECT * FROM user_model_access WHERE user_id=?').all(userId) as any[]).map(p => [p.model_id, p.access_mode]));
    const specs = new Map(getModelSpecifications().map(s => [s.modelId, s]));
    return allModels.map(m => ({ id: m.id, modelId: m.modelId, displayName: m.displayName, active: m.isActive === 1, kind: modelKind(m.capabilities),
      accessMode: access.get(m.id) || 'inherit', pricingMode: custom.has(m.id) ? 'custom' : 'inherit',
      defaultPrice: defaults.get(m.modelId) || null, customPrice: custom.get(m.id) || null,
      effectivePrice: custom.get(m.id) || defaults.get(m.modelId) || null,
      resolutions: [...new Set([...(specs.get(m.modelId)?.limits.resolutions || []), ...Object.keys(defaults.get(m.modelId)?.extraParams || {}),
        ...Object.keys(custom.get(m.id)?.extraParams || {})])].filter(key => /^(?:\d{3,4}p|\d+k)$/i.test(key)),
    }));
  }

  static saveMany(userId: number, actorId: number, changes: any[]): UserModelSetting[] {
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 2000) fail(400, '请提交 1–2000 个模型的修改');
    const ids = changes.map(change => change?.modelId);
    if (ids.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) fail(400, '模型编号无效或重复');
    ensureUserModelTables(sqlite);
    return sqlite.transaction(() => changes.map(change => this.save(userId, change.modelId, actorId, change)))();
  }

  static save(userId: number, modelId: number, actorId: number, data: any): UserModelSetting {
    if (!Number.isSafeInteger(modelId) || !Number.isSafeInteger(actorId)) fail(400, '无效的用户或模型编号');
    const current = this.list(userId).find(m => m.id === modelId);
    if (!current) fail(404, '模型不存在');
    if (!['inherit', 'allow', 'deny'].includes(data?.accessMode) || !['inherit', 'custom'].includes(data?.pricingMode)) fail(400, '请选择有效的权限与价格模式');
    let custom: UserModelPrice | null = null;
    if (data.pricingMode === 'custom') {
      if (!current.defaultPrice) fail(400, '请先为模型配置全局售价和计费单位');
      const input = data.customPrice;
      if (!input || input.billingType !== current.defaultPrice.billingType) fail(400, '专属价格必须沿用模型的计费单位，请刷新后重试');
      const validPrice = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e9;
      if (!validPrice(input.inputPrice) || !validPrice(input.outputPrice)) fail(400, '价格必须是大于或等于 0 的有效数字');
      if (!input.extraParams || typeof input.extraParams !== 'object' || Array.isArray(input.extraParams)) fail(400, '规格价格格式无效');
      const extraParams: Record<string, number> = {};
      for (const [key, value] of Object.entries(input.extraParams)) {
        if (!/^(?:\d{3,4}p|\d+k)$/i.test(key) || !validPrice(value)) fail(400, '分辨率价格必须是有效的非负数字');
        const normalized = current.resolutions.find(r => r.toLowerCase() === key.toLowerCase()) || key;
        if (normalized in extraParams) fail(400, '分辨率价格不能重复');
        extraParams[normalized] = Number(value);
      }
      custom = { billingType: input.billingType, inputPrice: input.inputPrice, outputPrice: input.outputPrice, extraParams };
    }
    return sqlite.transaction(() => {
      const before = this.list(userId).find(m => m.id === modelId)!;
      if (data.expectedRevision !== undefined && data.expectedRevision !== (before.customPrice?.revision ?? null)) fail(409, '其他管理员已修改该价格，请刷新后重试');
      if (data.accessMode === 'inherit') sqlite.prepare('DELETE FROM user_model_access WHERE user_id=? AND model_id=?').run(userId, modelId);
      else sqlite.prepare(`INSERT INTO user_model_access(user_id,model_id,access_mode) VALUES(?,?,?)
        ON CONFLICT(user_id,model_id) DO UPDATE SET access_mode=excluded.access_mode,updated_at=datetime('now')`).run(userId, modelId, data.accessMode);
      if (!custom) sqlite.prepare('DELETE FROM user_model_pricing WHERE user_id=? AND model_id=?').run(userId, modelId);
      else sqlite.prepare(`INSERT INTO user_model_pricing(user_id,model_id,billing_type,input_price,output_price,extra_params,updated_by)
        VALUES(?,?,?,?,?,?,?) ON CONFLICT(user_id,model_id) DO UPDATE SET billing_type=excluded.billing_type,input_price=excluded.input_price,
        output_price=excluded.output_price,extra_params=excluded.extra_params,updated_by=excluded.updated_by,revision=revision+1,updated_at=datetime('now')`)
        .run(userId, modelId, custom.billingType, custom.inputPrice, custom.outputPrice, JSON.stringify(custom.extraParams), actorId);
      const after = this.list(userId).find(m => m.id === modelId)!;
      sqlite.prepare('INSERT INTO user_model_audit(user_id,model_id,actor_id,before_json,after_json) VALUES(?,?,?,?,?)')
        .run(userId, modelId, actorId, JSON.stringify(before), JSON.stringify(after));
      return after;
    })();
  }
}
