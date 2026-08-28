import { db } from '../db/index.js';
import { modelPricing, models } from '../db/schema.js';
import { eq, desc } from 'drizzle-orm';

export const BILLING_TYPES = ['per_call', 'per_token', 'per_second', 'per_character'] as const;
export type BillingType = typeof BILLING_TYPES[number];
export type PricingCategory = 'text' | 'image' | 'video' | 'tts' | 'default' | 'other';

export interface PricingUsage {
  promptTokens?: number;
  completionTokens?: number;
  seconds?: number;
  characters?: number;
  count?: number;
  resolution?: string;
}

export interface PublicModelPricing {
  model: string;
  display_name: string;
  capabilities: string[];
  currency: 'CNY';
  billing_type: BillingType;
  unit: 'request' | 'second' | 'million_tokens' | 'character';
  unit_price: number;
  output_unit_price: number;
  resolution_prices: Record<string, number>;
  matched_pattern: string;
  inherited: boolean;
}

function parseExtraParams(value: string | null | undefined): Record<string, any> {
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function roundCost(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export class PricingService {
  private static getRule(modelName: string, allowWildcard = true) {
    const exact = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, modelName)).get();
    if (exact || !allowWildcard) return exact;
    return db.select().from(modelPricing).where(eq(modelPricing.modelPattern, '*')).get();
  }

  private static inferCategory(modelPattern: string, extraParams: Record<string, any>): PricingCategory {
    const explicit = String(extraParams.category || '').toLowerCase();
    if (['text', 'image', 'video', 'tts', 'default', 'other'].includes(explicit)) {
      return explicit as PricingCategory;
    }
    if (modelPattern === '*') return 'default';

    const model = db.select().from(models).where(eq(models.modelId, modelPattern)).get();
    if (model) {
      try {
        const capabilities = JSON.parse(model.capabilities || '[]') as string[];
        if (capabilities.includes('video')) return 'video';
        if (capabilities.includes('image')) return 'image';
        if (capabilities.includes('tts')) return 'tts';
        if (capabilities.includes('text')) return 'text';
      } catch { /* fall through to model-name inference */ }
    }

    const value = modelPattern.toLowerCase();
    if (value.includes('tts') || value.includes('speech')) return 'tts';
    if (value.includes('video') || value.includes('seedance') || value.includes('veo') || value.includes('sora') || value.includes('wan3')) return 'video';
    if (value.includes('image') || value.includes('banana')) return 'image';
    return 'text';
  }

  private static validateRule(data: any, currentId?: number) {
    const modelPattern = String(data.modelPattern || '').trim();
    if (!modelPattern) throw { status: 400, message: '模型标识不能为空' };

    const billingType = String(data.billingType || 'per_call') as BillingType;
    if (!BILLING_TYPES.includes(billingType)) {
      throw { status: 400, message: '不支持的计费类型' };
    }

    const inputPrice = Number(data.inputPrice ?? 0);
    const outputPrice = Number(data.outputPrice ?? 0);
    if (!Number.isFinite(inputPrice) || inputPrice < 0 || !Number.isFinite(outputPrice) || outputPrice < 0) {
      throw { status: 400, message: '价格必须是大于或等于 0 的有效数字' };
    }

    const duplicate = db.select().from(modelPricing).where(eq(modelPricing.modelPattern, modelPattern)).get();
    if (duplicate && duplicate.id !== currentId) {
      throw { status: 409, message: `模型 ${modelPattern} 已有计费规则，请直接编辑现有规则` };
    }

    const extraParams = data.extraParams && typeof data.extraParams === 'object' && !Array.isArray(data.extraParams)
      ? data.extraParams
      : {};
    return { modelPattern, billingType, inputPrice, outputPrice, extraParams };
  }

  /** Build public pricing descriptors for externally visible model IDs. */
  static getPublicPricingForModels(modelNames: string[]): PublicModelPricing[] {
    const uniqueModelNames = Array.from(new Set(modelNames));
    if (uniqueModelNames.length === 0) return [];

    const pricingRows = db.select().from(modelPricing).all();
    const exactRules = new Map(pricingRows.map(rule => [rule.modelPattern, rule]));
    const wildcardRule = exactRules.get('*');
    const modelRows = db.select().from(models).all();
    const modelMap = new Map(modelRows.map(model => [model.modelId, model]));
    const unitMap: Record<BillingType, PublicModelPricing['unit']> = {
      per_call: 'request',
      per_second: 'second',
      per_token: 'million_tokens',
      per_character: 'character',
    };

    return uniqueModelNames.flatMap(modelName => {
      const exactRule = exactRules.get(modelName);
      const exactExtra = parseExtraParams(exactRule?.extraParams);
      const category = this.inferCategory(modelName, exactExtra);
      // Video/image/TTS billing requires an exact rule; only text may inherit '*'.
      const rule = exactRule || (category === 'text' ? wildcardRule : undefined);
      if (!rule) return [];

      const extra = parseExtraParams(rule.extraParams);
      const model = modelMap.get(modelName);
      let capabilities: string[] = [];
      try {
        const parsed = JSON.parse(model?.capabilities || '[]');
        if (Array.isArray(parsed)) capabilities = parsed.filter(value => typeof value === 'string');
      } catch { /* use inferred capability below */ }
      if (capabilities.length === 0 && ['text', 'image', 'video', 'tts'].includes(category)) {
        capabilities = [category];
      }

      const resolutionPrices = Object.fromEntries(
        Object.entries(extra)
          .filter(([key, value]) => key !== 'category' && Number.isFinite(Number(value)) && Number(value) >= 0)
          .map(([key, value]) => [key, Number(value)]),
      );
      const billingType = rule.billingType as BillingType;

      return [{
        model: modelName,
        display_name: model?.displayName || modelName,
        capabilities,
        currency: 'CNY' as const,
        billing_type: billingType,
        unit: unitMap[billingType],
        unit_price: rule.inputPrice,
        output_unit_price: rule.outputPrice,
        resolution_prices: resolutionPrices,
        matched_pattern: rule.modelPattern,
        inherited: rule.modelPattern !== modelName,
      }];
    });
  }

  /** 获取规则，并补充模型名称与业务分类；可供管理页搜索及筛选。 */
  static getPricingRules(query: { category?: string; billingType?: string; search?: string; scope?: 'all' | 'active' } = {}) {
    const modelRows = db.select().from(models).all();
    const modelMap = new Map(modelRows.map(model => [model.modelId, model]));
    const search = String(query.search || '').trim().toLowerCase();

    const pricingRows = db.select().from(modelPricing).orderBy(desc(modelPricing.createdAt)).all();
    const persistedRules = pricingRows.map(rule => {
        const extraParams = parseExtraParams(rule.extraParams);
        const model = modelMap.get(rule.modelPattern);
        return {
          ...rule,
          extraParams,
          category: this.inferCategory(rule.modelPattern, extraParams),
          displayName: model?.displayName || (rule.modelPattern === '*' ? '全局默认规则' : rule.modelPattern),
          modelActive: model ? model.isActive === 1 : null,
          configured: true,
          inherited: false,
        };
      });

    let result: any[] = persistedRules;
    if (query.scope === 'active') {
      const exactRuleMap = new Map(persistedRules.map(rule => [rule.modelPattern, rule]));
      const defaultRule = exactRuleMap.get('*');
      const activeModelRules = modelRows
        .filter(model => model.isActive === 1)
        .map(model => {
          const exactRule = exactRuleMap.get(model.modelId);
          if (exactRule) return exactRule;

          const category = this.inferCategory(model.modelId, {});
          const inheritsDefault = category === 'text' && Boolean(defaultRule);
          return {
            id: null,
            modelPattern: model.modelId,
            displayName: model.displayName || model.modelId,
            category,
            billingType: inheritsDefault ? defaultRule.billingType : category === 'tts' ? 'per_character' : 'per_call',
            inputPrice: inheritsDefault ? defaultRule.inputPrice : 0,
            outputPrice: inheritsDefault ? defaultRule.outputPrice : 0,
            extraParams: { category },
            createdAt: null,
            modelActive: true,
            configured: false,
            inherited: inheritsDefault,
          };
        });
      result = defaultRule ? [defaultRule, ...activeModelRules] : activeModelRules;
    }

    return result
      .filter(rule => !query.category || query.category === 'all' || rule.category === query.category)
      .filter(rule => !query.billingType || query.billingType === 'all' || rule.billingType === query.billingType)
      .filter(rule => !search || rule.modelPattern.toLowerCase().includes(search) || rule.displayName.toLowerCase().includes(search));
  }

  static createPricingRule(data: any) {
    const rule = this.validateRule(data);
    db.insert(modelPricing).values({
      modelPattern: rule.modelPattern,
      billingType: rule.billingType,
      inputPrice: rule.inputPrice,
      outputPrice: rule.outputPrice,
      extraParams: JSON.stringify(rule.extraParams),
    }).run();
  }

  static updatePricingRule(id: number, data: any) {
    const current = db.select().from(modelPricing).where(eq(modelPricing.id, id)).get();
    if (!current) throw { status: 404, message: '计费规则不存在' };

    const currentExtra = parseExtraParams(current.extraParams);
    const rule = this.validateRule({
      modelPattern: data.modelPattern ?? current.modelPattern,
      billingType: data.billingType ?? current.billingType,
      inputPrice: data.inputPrice ?? current.inputPrice,
      outputPrice: data.outputPrice ?? current.outputPrice,
      extraParams: data.extraParams ?? currentExtra,
    }, id);

    db.update(modelPricing).set({
      modelPattern: rule.modelPattern,
      billingType: rule.billingType,
      inputPrice: rule.inputPrice,
      outputPrice: rule.outputPrice,
      extraParams: JSON.stringify(rule.extraParams),
    }).where(eq(modelPricing.id, id)).run();
  }

  static deletePricingRule(id: number) {
    const rule = db.select().from(modelPricing).where(eq(modelPricing.id, id)).get();
    if (!rule) throw { status: 404, message: '计费规则不存在' };
    db.delete(modelPricing).where(eq(modelPricing.id, id)).run();
  }

  /** 返回单价及最终费用。视频等非文本业务默认不使用全局 Token 兜底。 */
  static quote(modelName: string, usage: PricingUsage = {}, allowWildcard = true) {
    const rule = this.getRule(modelName, allowWildcard);
    if (!rule) return { rate: 0, cost: 0, billingType: null as BillingType | null, matchedPattern: null };

    const extra = parseExtraParams(rule.extraParams);
    const resolutionRate = usage.resolution !== undefined ? Number(extra[usage.resolution]) : NaN;
    const rate = Number.isFinite(resolutionRate) && resolutionRate >= 0 ? resolutionRate : rule.inputPrice;
    let cost = 0;

    switch (rule.billingType as BillingType) {
      case 'per_token':
        cost = ((usage.promptTokens || 0) / 1_000_000) * rate
          + ((usage.completionTokens || 0) / 1_000_000) * rule.outputPrice;
        break;
      case 'per_second':
        cost = rate * Math.max(0, Number(usage.seconds || 0));
        break;
      case 'per_character':
        cost = rate * Math.max(0, Number(usage.characters || 0));
        break;
      case 'per_call':
      default:
        cost = rate * Math.max(0, Number(usage.count ?? 1));
        break;
    }

    return {
      rate,
      cost: roundCost(cost),
      billingType: rule.billingType as BillingType,
      matchedPattern: rule.modelPattern,
    };
  }

  /** 兼容现有文本/图片调用。 */
  static calculateCost(modelName: string, promptTokens: number, completionTokens: number): number {
    return this.quote(modelName, { promptTokens, completionTokens }).cost;
  }

  /** 视频、语音等按用量业务必须精确匹配，避免误用全局 Token 价格。 */
  static calculateUsageCost(modelName: string, usage: PricingUsage): number {
    return this.quote(modelName, usage, false).cost;
  }
}
