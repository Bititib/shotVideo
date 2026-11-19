import { image2proPublicPricing } from './image2proUpstreamPricing.js';
import type { ChannelModelCatalogEntry } from '../../shared/channelModelConfiguration.js';

const sources = ['https://api.image2pro.top/api-console/public-models', 'https://vpn.image2pro.top/models', 'https://image2pro.top/'] as const;
// Public, read-only sources. Never forward a channel key or execute website JavaScript.
export async function enrichImage2proCatalog(catalog: ChannelModelCatalogEntry[], fetcher: typeof fetch = fetch) {
  const hasImages = catalog.some(entry => entry.kind === 'image');
  const results = await Promise.allSettled(sources.map(async (url, index) => {
    if (index > 0 && !hasImages) return index === 2 ? '' : [];
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = await response.text();
    if (text.length > 4_000_000) throw new Error('公开配置过大');
    if (index === 2) return text;
    const data = JSON.parse(text);
    if (data.ok !== true || !Array.isArray(data.models)) throw new Error('公开目录格式变更');
    return data.models.filter((row: unknown) => row !== null && typeof row === 'object' && !Array.isArray(row));
  }));
  const publicModels: any[] = results[0].status === 'fulfilled' ? results[0].value : [];
  const websiteModels: any[] = results[1].status === 'fulfilled' ? results[1].value : [];
  const html: string = results[2].status === 'fulfilled' ? results[2].value : '';
  const ratioBlock = html.split('const RATIO_OPTIONS_BY_PROTOCOL = {')[1]?.split('\n};')[0] || '';
  const pickerLimit = Number(html.match(/const MAX_REF_IMAGES\s*=\s*(\d+);/)?.[1]);
  const checkedAt = new Date().toISOString();
  return catalog.map(entry => {
    if (entry.kind === 'text' || entry.kind === 'video') {
      const matches = publicModels.filter(m => m.type === entry.kind && m.id === entry.id);
      const upstreamPricing = image2proPublicPricing(entry.kind, matches.length === 1 ? matches[0] : undefined);
      if (results[0].status === 'rejected') upstreamPricing.note = '公开价格查询失败；本次未取得报价。' + upstreamPricing.note;
      else if (matches.length !== 1) upstreamPricing.note = '公开目录未找到唯一对应型号；价格未公布。' + upstreamPricing.note;
      return { ...entry, upstreamPricing };
    }
    if (entry.kind !== 'image' || !entry.limits) return entry;
    const limits = { ...entry.limits };
    const notes: string[] = [];
    results.forEach((result, i) => { if (result.status === 'rejected') notes.push('公开查询不可用：' + sources[i] + '；保留授权目录参数'); });
    const matches = publicModels.filter(m => m.type === 'image' && m.id === entry.id);
    const pub = matches.length === 1 ? matches[0] : undefined;
    // Public API IDs are website display names; internal website IDs are NOT API IDs.
    const web = pub ? websiteModels.filter(m => m.type === 'image' && m.name === pub.name) : [];
    const protocols = [...new Set(web.map(m => m.protocol))];
    const protocol = protocols.length === 1 ? protocols[0] : undefined;
    if (!pub || !web.length || protocols.length !== 1) notes.push('官网型号对应关系未公布或存在歧义；不猜测参数');
    if (protocol === 'midjourney-image') {
      notes.push('专属 Midjourney 协议尚未接入；不可按普通图片配置启用');
      return { ...entry, imageEvidence: { checkedAt, notes } };
    }
    if (!entry.imageOptions?.customRatios) notes.push('比例：授权目录明确选项');
    else {
      const allowed = typeof protocol === 'string' && /^[a-z0-9-]+$/.test(protocol)
        ? ratioBlock.match(new RegExp('"' + protocol + '"\\s*:\\s*\\[([\\s\\S]*?)\\]'))?.[1] : '';
      const ratios = [...(allowed || '').matchAll(/value:\s*"([0-9.:]+)"/g)].map(m => m[1]);
      // Current local routing accepts integer ratios only; never silently convert decimal aliases.
      const supported = ratios.filter(v => /^[1-9]\d*:[1-9]\d*$/.test(v));
      if (supported.length) { limits.ratios = [...new Set(supported)]; notes.push('比例：官网协议可选项，尚未逐项实测'); }
      else notes.push('比例：未公布，保留授权目录或 auto');
      if (ratios.length !== supported.length) notes.push('官网另有小数比例 ' + ratios.filter(v => !supported.includes(v)).join('、') + '，本站暂未支持，未自动填写');
    }
    if (!entry.imageOptions?.customResolutions) notes.push('分辨率：授权目录明确选项');
    else {
      const values = [...new Set((protocol ? web : []).map(m => m.openaiResolution || m.geminiImageSize).filter(v => typeof v === 'string'))];
      if (values.length === 1 && /^(?:[1-9]\d?K|[1-9]\d{2,4}p)$/.test(values[0])) {
        limits.resolutions = [values[0]];
        notes.push('分辨率：官网默认值 ' + values[0] + '；完整可选范围未公布，默认值不等于上限');
      } else notes.push('分辨率：未公布或默认值冲突，保留授权目录或 auto');
    }
    if (entry.imageOptions?.referenceLimitPublished) notes.push('参考图：授权目录上限 ' + limits.maxImages + ' 张');
    else if (pub?.supportsReference === false) { limits.maxImages = 0; limits.minImages = 0; notes.push('参考图：公开 API 目录明确不支持'); }
    else if (pub?.supportsReference === true && pickerLimit > 0 && pickerLimit <= 16 && protocol && protocol !== 'muse-image') {
      limits.maxImages = pickerLimit;
      notes.push('参考图：按官网上传入口限制填 ' + pickerLimit + ' 张；该型号 API 上限未公布，不代表接口极限');
    } else notes.push('参考图：型号上限未公布，保留授权目录值；通用接口 16 张不是型号能力');
    return { ...entry, limits, imageEvidence: { checkedAt, notes } };
  });
}
