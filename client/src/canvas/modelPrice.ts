import { HUSS_MJ_MODEL } from '../../../shared/hussMidjourney';
import { getBillingUnit } from '../utils/billing';
import type { CanvasModel } from './useCanvasModels';
import type { GenerationDraft } from './model';

const validPrice = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const money = (value: number) => value > 0 && value < 0.000001 ? '¥' + value.toString() : '¥' + value.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });

/** Catalog unit prices only. The selected task still uses its server quote. */
export function canvasModelPrice(model: CanvasModel, kind: GenerationDraft['kind']): string {
  if (kind === 'audio') return validPrice(model.rate) ? money(model.rate) + '/字' : '价格待确认';
  const unit = kind === 'video' ? getBillingUnit(model.billingType, 'video')
    : model.id === HUSS_MJ_MODEL || model.routingLimits?.outputsPerTask ? '/次' : '/张';
  if (!unit) return '计费方式待确认';
  const prices = Object.entries(kind === 'video' ? model.rates || {} : model.resolutionPrices || {})
    .filter((entry): entry is [string, number] => validPrice(entry[1]));
  if (prices.length) return prices.map(([resolution, price]) => `${resolution} ${money(price)}${unit}`).join(' · ');
  return kind === 'image' && validPrice(model.rate) ? money(model.rate) + unit : '价格待确认';
}
