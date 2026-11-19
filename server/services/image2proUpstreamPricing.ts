import type { Image2proUpstreamPricing } from '../../shared/channelModelConfiguration.js';

// Key-scoped prices only: a public catalog may belong to a different billing group.
// Never coerce missing/null/empty prices to zero or use the other operation's price.
export function image2proUpstreamPricing(metadata: Record<string, unknown>): Image2proUpstreamPricing {
  const price = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  return {
    textToImage: price(metadata.text_to_image_price),
    imageToImage: price(metadata.image_to_image_price),
    unit: '上游 API 积分 / 张',
    source: '当前渠道 Key 的 /v1/models 授权目录',
    checkedAt: new Date().toISOString(),
  };
}

// These camelCase fields and billing units are from /api-console/public-models,
// not inferred aliases for the key-scoped /v1/models metadata.
export function image2proPublicPricing(kind: 'video' | 'text', model?: Record<string, unknown>): Image2proUpstreamPricing {
  const expectedUnit = kind === 'video' ? 'video' : 'request';
  const raw = model?.[kind === 'video' ? 'videoPrice' : 'textPricePerRequest'];
  const validUnit = model?.billingUnit === expectedUnit;
  const value = validUnit && typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? raw : null;
  return {
    textToImage: null, imageToImage: null,
    ...(kind === 'video' ? {video:value} : {textPerRequest:value}),
    unit: validUnit ? (kind === 'video' ? '上游 API 积分 / 条视频' : '上游 API 积分 / 次请求') : '未公布或未识别',
    checkedAt: new Date().toISOString(),
    source: 'Image2Pro 公开型号目录 /api-console/public-models（参考价）',
    note: '公开参考价不代表当前 Key 分组的实际结算价；时长、清晰度、Token 或附加费用分档未公布，不据此推算。',
  };
}
