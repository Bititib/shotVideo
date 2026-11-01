import { defaultRoutingLimits } from './modelRouting.js';
export const HUSS_MJ_MODEL = 'Midjourney V8.2';
export const isHussMidjourney = (id: string) => id === HUSS_MJ_MODEL;
export const hussMjLimits = () => ({ ...defaultRoutingLimits(), maxImages: 1, maxOutputs: 1,
  resolutions: ['1K', '2K'], ratios: ['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3'], qualities: ['0.25', '0.5', '1', '2'] });
export const hussMjFields = ['style','stylize','sref','sw','chaos','weird','seed','iw','tile','negative_prompt','quality'] as const;
export type HussMjOptions = Partial<Record<typeof hussMjFields[number], string | number | boolean>>;
/** Only documented V8.2 controls; never silently truncate prompt or references. */
export function hussMjOptions(body: Record<string, any>): HussMjOptions {
  const out: Record<string, any> = {};
  for (const field of ['cref','cw','stop','draft','version','bot_type','extra']) {
    if (body[field] !== undefined) throw new Error('Midjourney V8.2 不支持参数 ' + field);
  }
  for (const field of hussMjFields) if (body[field] !== undefined && body[field] !== '') out[field] = body[field];
  if (out.style !== undefined && out.style !== 'raw') throw new Error('渲染模式只能选择 raw，艺术风格请写入提示词');
  for (const [field, max] of Object.entries({stylize:1000,sw:1000,chaos:100,weird:3000,seed:4294967295})) {
    if (out[field] === undefined) continue;
    const n = Number(out[field]);
    if (!/^[0-9]+$/.test(String(out[field])) || !Number.isSafeInteger(n) || n < 0 || n > max) throw new Error(field + ' 须为 0–' + max + ' 的整数');
    out[field] = field === 'seed' ? n : String(n);
  }
  if (out.tile !== undefined && typeof out.tile !== 'boolean') throw new Error('tile 须为布尔值');
  if (out.iw !== undefined) {
    const n = Number(out.iw); if (!Number.isFinite(n) || n < 0) throw new Error('普通参考图权重须为非负数字');
    out.iw = String(n);
  }
  if (out.quality !== undefined && !['0.25','0.5','1','2'].includes(String(out.quality))) throw new Error('质量须为 0.25、0.5、1 或 2');
  if (out.sref !== undefined) {
    const u = new URL(out.sref); if (u.protocol !== 'https:' || u.username || u.password) throw new Error('风格参考图须为公开 HTTPS 图片直链');
  }
  return out;
}
