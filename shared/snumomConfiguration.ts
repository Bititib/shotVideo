import type { ModelInputLimits, ModelRoute } from './modelRouting.js';

/** Only the documented /v1/videos JSON contract; not token-priced or alternate protocols. */
export function validateSnumomConfiguration(l: ModelInputLimits, billing: ModelRoute['snumom']) {
  if (!billing || !['per_call','per_second'].includes(billing.billingType) || typeof billing.referenceVideoBilling !== 'boolean'
    || billing.referenceVideoBilling && billing.billingType !== 'per_second') throw new Error('请选择按次或按秒；参考视频计费仅适用于按秒');
  if (l.maxOutputs !== 1 || l.qualities.length || l.outputsPerTask !== undefined
    || ![l.duration.min,l.duration.max,l.duration.step,...l.duration.values].every(Number.isSafeInteger)
    || l.resolutions.some(r=>!['480p','720p','1080p'].includes(r))
    || l.ratios.some(r=>!['16:9','9:16','1:1','4:3','3:4','21:9','adaptive'].includes(r))
    || l.lastFrame && !l.firstFrame) throw new Error('snumom 同接口配置须为整数秒、480p/720p/1080p、受支持画幅，每次一条视频；尾帧须同时支持首帧');
}
