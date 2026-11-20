// Exact tier sizes used by the provider's public image toolbar; 4K is a tier, not always a 4096 px edge.
export const APIPATH_SUNBURST = 'gpt-image-2-5-sunburst';
export const APIPATH_IMAGE_SIZES: Record<string, Record<string,string>> = {
  "1:1": {
    "1K": "1024x1024",
    "2K": "2048x2048",
    "4K": "2880x2880"
  },
  "16:9": {
    "1K": "1280x720",
    "2K": "2560x1440",
    "4K": "3840x2160"
  },
  "9:16": {
    "1K": "720x1280",
    "2K": "1440x2560",
    "4K": "2160x3840"
  },
  "3:2": {
    "1K": "1248x832",
    "2K": "2496x1664",
    "4K": "3504x2336"
  },
  "2:3": {
    "1K": "832x1248",
    "2K": "1664x2496",
    "4K": "2336x3504"
  },
  "4:3": {
    "1K": "1152x864",
    "2K": "2304x1728",
    "4K": "3264x2448"
  },
  "3:4": {
    "1K": "864x1152",
    "2K": "1728x2304",
    "4K": "2448x3264"
  },
  "21:9": {
    "1K": "1456x624",
    "2K": "3024x1296",
    "4K": "3696x1584"
  }
};
export const APIPATH_LEGACY_IMAGE_IDS = ['1k','2k','4k'].map(tier => APIPATH_SUNBURST + '-' + tier);
export const isApipathSunburstSpec = (model: string) => model === APIPATH_SUNBURST || APIPATH_LEGACY_IMAGE_IDS.includes(model);
export function apipathImageSize(ratio: string, resolution: string, explicitSize?: string): string {
  const size = APIPATH_IMAGE_SIZES[ratio]?.[resolution.toUpperCase()];
  if (!size) throw new Error('通联 Sunburst 图片比例或分辨率不支持');
  if (explicitSize && explicitSize !== size) throw new Error('size 与通联 Sunburst 输出规格不一致，所选规格要求 ' + size);
  return size;
}
