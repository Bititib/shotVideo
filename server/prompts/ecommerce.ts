import { Type } from '@google/genai';

export function ecommercePrompt(videoTitle?: string): string {
  return `你是一个专业的TikTok/抖音带货视频操盘手和AI视频提示词专家。
请分析我提供的带货视频${videoTitle ? `（标题为："${videoTitle}"）` : ''}，并输出以下维度的结构化分析结果：
1. 商品名称 (productName)：识别视频中售卖的核心商品。
2. 最佳展示时间戳 (bestProductShotTimestamp)：请找出视频中商品展示最清晰的那一帧画面的具体时间（以秒为单位，如 2.5）。
3. 核心卖点 (sellingPoints)：提取视频中强调的3-5个商品核心卖点。
4. 目标人群 (targetAudience)：分析该视频主要针对的受众群体特征。
5. 痛点与钩子 (hookAnalysis)：分析视频开头前3秒是如何抓住观众眼球的。
6. 视觉丰富度与情感共鸣 (visualAndEmotionAnalysis)：分析视频的视觉冲击力、色彩运用、情感共鸣点。
7. 逆向视频生成提示词 (reversePrompt)：请严格按照【时间轴与结构化排版】输出一段【100%纯英文】的带货视频生成提示词，涵盖视频全部长度。
8. 提示词中文翻译 (reversePromptTranslation)：将上述纯英文提示词完整翻译成中文。
9. 逆向图片生成提示词 (imageReversePrompt)：请输出一段【100%纯英文】的图片生成提示词，用于生成该商品的绝佳展示图。
10. 图片提示词中文翻译 (imageReversePromptTranslation)：将上述纯英文图片提示词完整翻译成中文。
11. 促单话术 (callToAction)：分析视频结尾是如何引导用户下单的。
12. 脚本文案分析 (scriptAnalysis)：详细拆解视频脚本结构，包含 overview（整体概述）、hook（开头钩子）、body（主体内容）、callToAction（促单部分）、keywords（核心关键词数组）。
13. 视频完整语音文案 (videoTranscript)：转录视频中所有人物对白和旁白的完整文案。`;
}

export const ecommerceSchema = {
  type: Type.OBJECT,
  properties: {
    productName: { type: Type.STRING },
    bestProductShotTimestamp: { type: Type.NUMBER },
    sellingPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
    targetAudience: { type: Type.STRING },
    hookAnalysis: { type: Type.STRING },
    visualAndEmotionAnalysis: { type: Type.STRING },
    reversePrompt: { type: Type.STRING },
    reversePromptTranslation: { type: Type.STRING },
    imageReversePrompt: { type: Type.STRING },
    imageReversePromptTranslation: { type: Type.STRING },
    callToAction: { type: Type.STRING },
    scriptAnalysis: {
      type: Type.OBJECT,
      properties: {
        overview: { type: Type.STRING },
        hook: { type: Type.STRING },
        body: { type: Type.STRING },
        callToAction: { type: Type.STRING },
        keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['overview', 'hook', 'body', 'callToAction', 'keywords'],
    },
    videoTranscript: { type: Type.STRING },
  },
  required: ['productName', 'bestProductShotTimestamp', 'sellingPoints', 'targetAudience', 'hookAnalysis', 'visualAndEmotionAnalysis', 'reversePrompt', 'reversePromptTranslation', 'imageReversePrompt', 'imageReversePromptTranslation', 'callToAction', 'scriptAnalysis', 'videoTranscript'],
};

export function modifyPromptTemplate(existingPrompt: string): string {
  return `你是一个专业的AI视频提示词专家。
我有一段现有的带货视频生成提示词，以及一张新产品的图片。
请分析这张新产品图片，并将现有提示词中的原产品替换为图片中的新产品。
保持原有的视频风格、镜头语言（特别是人物占位、机位角度、运镜方式）、场景结构和时间轴不变，仅仅替换产品描述。

现有纯英文提示词：
${existingPrompt}

请输出以下JSON格式的结果：
1. reversePrompt: 修改后的【100%纯英文】提示词。
2. reversePromptTranslation: 修改后的提示词的中文翻译。`;
}

export const modifyPromptSchema = {
  type: Type.OBJECT,
  properties: {
    reversePrompt: { type: Type.STRING },
    reversePromptTranslation: { type: Type.STRING },
  },
  required: ['reversePrompt', 'reversePromptTranslation'],
};
