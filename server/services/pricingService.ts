import { db } from '../db/index.js';
import { modelPricing } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';

export class PricingService {
  /** 获取所有计费规则 */
  static getPricingRules() {
    return db.select().from(modelPricing).orderBy(desc(modelPricing.createdAt)).all()
      .map(r => ({
        ...r,
        extraParams: JSON.parse(r.extraParams),
      }));
  }

  /** 创建计费规则 */
  static createPricingRule(data: any) {
    const { modelPattern, billingType, inputPrice, outputPrice, extraParams } = data;
    if (!modelPattern) throw { status: 400, message: '模型匹配模式不能为空' };

    db.insert(modelPricing).values({
      modelPattern,
      billingType: billingType || 'per_call',
      inputPrice: inputPrice ?? 0,
      outputPrice: outputPrice ?? 0,
      extraParams: JSON.stringify(extraParams || {}),
    }).run();
  }

  /** 编辑计费规则 */
  static updatePricingRule(id: number, data: any) {
    const rule = db.select().from(modelPricing).where(eq(modelPricing.id, id)).get();
    if (!rule) throw { status: 404, message: '计费规则不存在' };

    const updates: Record<string, any> = {};
    if (data.modelPattern !== undefined) updates.modelPattern = data.modelPattern;
    if (data.billingType !== undefined) updates.billingType = data.billingType;
    if (data.inputPrice !== undefined) updates.inputPrice = data.inputPrice;
    if (data.outputPrice !== undefined) updates.outputPrice = data.outputPrice;
    if (data.extraParams !== undefined) updates.extraParams = JSON.stringify(data.extraParams);

    if (Object.keys(updates).length > 0) {
      db.update(modelPricing).set(updates).where(eq(modelPricing.id, id)).run();
    }
  }

  /** 删除计费规则 */
  static deletePricingRule(id: number) {
    db.delete(modelPricing).where(eq(modelPricing.id, id)).run();
  }

  /** 根据模型名计算费用 */
  static calculateCost(modelName: string, promptTokens: number, completionTokens: number): number {
    // 先查找精确匹配的规则
    const rules = db.select().from(modelPricing).all();
    let matchedRule = rules.find(r => r.modelPattern === modelName);
    // 未匹配则找通配符规则
    if (!matchedRule) matchedRule = rules.find(r => r.modelPattern === '*');
    if (!matchedRule) return 0;

    if (matchedRule.billingType === 'per_call') {
      return matchedRule.inputPrice;
    } else {
      // per_token: 价格单位是 元/1M tokens
      const inputCost = (promptTokens / 1_000_000) * matchedRule.inputPrice;
      const outputCost = (completionTokens / 1_000_000) * matchedRule.outputPrice;
      return Math.round((inputCost + outputCost) * 1_000_000) / 1_000_000; // 防浮点误差
    }
  }
}
