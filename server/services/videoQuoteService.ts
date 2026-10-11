import { db } from '../db/index.js';
import { models } from '../db/schema.js';
import { resolvePublicModelId } from './publicModelNameService.js';
import { getModelSpecification } from './modelRoutingService.js';
import { existingModelLimits } from './modelInputPresets.js';
import { PricingService } from './pricingService.js';
const fail = (message: string, status = 400) => Object.assign(new Error(message), { status });
/** Quote customer prices only. No uploads, upstream calls, reservations or task creation. */
export function quoteVideoRequest(body: any) {
  const model = resolvePublicModelId(String(body?.model || ''));
  const row = db.select().from(models).all().find(m => m.modelId === model);
  const spec = getModelSpecification(model);
  if (!row || !row.isActive || !JSON.parse(row.capabilities).includes('video') || spec?.enabled === false) throw fail('视频模型未开放', 404);
  const seconds = Number(body.video_length ?? body.seconds);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 3600) throw fail('请选择有效的视频时长');
  if (typeof body.resolution !== 'string' || !body.resolution.trim()) throw fail('请选择输出分辨率');
  const limits = spec?.limits || existingModelLimits(model, 'video');
  const resolution = limits?.resolutions.find(r => r.toLowerCase() === body.resolution.toLowerCase()) || body.resolution;
  if (limits) {
    if (!limits.resolutions.includes(resolution)) throw fail('该模型不支持所选分辨率');
    const d = limits.duration;
    if (!(d.mode === 'fixed' ? seconds === d.min : d.mode === 'options' ? d.values.includes(seconds)
      : seconds >= d.min && seconds <= d.max && Math.abs((seconds-d.min)/d.step - Math.round((seconds-d.min)/d.step)) < 1e-8)) throw fail('该模型不支持所选时长');
  }
  const quote = PricingService.quote(model, { resolution, seconds, count: 1 }, false);
  if (!['per_call', 'per_second'].includes(quote.billingType || '') || !Number.isFinite(quote.cost) || quote.cost < 0) throw fail('该模型尚未配置有效视频售价');
  return { model, resolution, seconds, cost: quote.cost, rate: quote.rate, billingType: quote.billingType };
}
/** Browser clients pin the displayed total; old API clients may omit expectedCost. */
export function assertExpectedVideoCost(body: any, actualCost: number) {
  if (body.expectedCost === undefined) return;
  if (typeof body.expectedCost !== 'number' || !Number.isFinite(body.expectedCost) || body.expectedCost < 0) throw fail('预计消费金额无效');
  if (Math.abs(body.expectedCost - actualCost) > 0.0000001) throw fail('售价已更新，请刷新预计费用后重新提交，本次未扣费', 409);
}
