import { Type } from '@google/genai';

export function copywritingPrompt(): string {
  return `你是一个顶级的跨境电商营销专家、视觉总监和文案大师。
请分析我提供的产品素材（图片或视频），并为该产品生成 TikTok 爆款短视频文案、Amazon 亚马逊产品详情页（Listing）文案，以及【高转化A+详情页/海报配图策划】。
请严格按照以下结构输出 JSON：
1. tiktok: 包含 hook (吸引眼球的开头/黄金3秒), caption (视频描述/脚本), hashtags (标签数组)。
2. amazon: 包含 title (SEO优化的标题), bulletPoints (5个核心卖点), productDescription (详细的产品描述), searchTerms (后台搜索关键词数组)。
3. detailPageImages: 详情页高级信息图（A+ Content）策划（5-6张图的规划），包含:
   - imageType: 图片类型
   - textOverlay: 需要后期排版在图片上的文案数组
   - description: 画面底图内容描述
   - prompt: 用于AI绘画工具生成该图片的纯英文提示词`;
}

export const copywritingSchema = {
  type: Type.OBJECT,
  properties: {
    tiktok: {
      type: Type.OBJECT,
      properties: {
        hook: { type: Type.STRING },
        caption: { type: Type.STRING },
        hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['hook', 'caption', 'hashtags'],
    },
    amazon: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING },
        bulletPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
        productDescription: { type: Type.STRING },
        searchTerms: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['title', 'bulletPoints', 'productDescription', 'searchTerms'],
    },
    detailPageImages: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          imageType: { type: Type.STRING },
          textOverlay: { type: Type.ARRAY, items: { type: Type.STRING } },
          description: { type: Type.STRING },
          prompt: { type: Type.STRING },
        },
        required: ['imageType', 'textOverlay', 'description', 'prompt'],
      },
    },
  },
  required: ['tiktok', 'amazon', 'detailPageImages'],
};
