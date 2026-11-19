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
