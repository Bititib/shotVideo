import { Type } from '@google/genai';

export function accountPrompt(handle: string, description: string): string {
  return `你是一个顶级的TikTok/短视频账号操盘手、数据分析师和内容战略专家。
请根据我提供的账号信息（账号名/链接：${handle}，账号描述：${description}）以及上传的账号主页/视频截图，对该账号进行全方位的深度拆解分析。
请严格按照以下结构输出 JSON：
1. contentAnalysis: 视频内容分析（summary, commonalities, visualStyle, hashtagsAndKeywords）。
2. audioAnalysis: 音乐与音频策略（musicStyle: 整体音乐风格, audioSources: 常用音频来源数组, soundEffects: 音效使用技巧数组）。
3. growthStrategy: 涨粉与流量策略（followerReason: 吸引力, hookPatterns: Hook套路数组, engagementTactics: 互动与留存技巧数组）。
4. audienceAnalysis: 目标人群分析（demographics, psychographics, painPoints）。
5. improvementPlan: 改进与差异化方案（weaknesses, differentiation）。
6. operationalAnalysis: 背后运作深度剖析（monetization, teamStructure, workflow: 对象数组包含 phase 和 description）。
7. actionableBlueprint: 对标超越实操蓝图（positioning, contentPillars, executionSteps, visualConcepts: {avatarPrompt, coverStylePrompt}）。
8. calculatedPlayCount: 估算总播放量（识别截图里所有视频具体的播放量数字并相加，给出 estimatedTotal 字符串和 explanation 依据）。`;
}

export const accountSchema = {
  type: Type.OBJECT,
  properties: {
    contentAnalysis: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        commonalities: { type: Type.ARRAY, items: { type: Type.STRING } },
        visualStyle: { type: Type.STRING },
        hashtagsAndKeywords: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['summary', 'commonalities', 'visualStyle', 'hashtagsAndKeywords'],
    },
    audioAnalysis: {
      type: Type.OBJECT,
      properties: {
        musicStyle: { type: Type.STRING },
        audioSources: { type: Type.ARRAY, items: { type: Type.STRING } },
        soundEffects: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['musicStyle', 'audioSources', 'soundEffects'],
    },
    growthStrategy: {
      type: Type.OBJECT,
      properties: {
        followerReason: { type: Type.STRING },
        hookPatterns: { type: Type.ARRAY, items: { type: Type.STRING } },
        engagementTactics: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['followerReason', 'hookPatterns', 'engagementTactics'],
    },
    audienceAnalysis: {
      type: Type.OBJECT,
      properties: {
        demographics: { type: Type.STRING },
        psychographics: { type: Type.STRING },
        painPoints: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['demographics', 'psychographics', 'painPoints'],
    },
    improvementPlan: {
      type: Type.OBJECT,
      properties: {
        weaknesses: { type: Type.ARRAY, items: { type: Type.STRING } },
        differentiation: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
      required: ['weaknesses', 'differentiation'],
    },
    operationalAnalysis: {
      type: Type.OBJECT,
      properties: {
        monetization: { type: Type.STRING },
        teamStructure: { type: Type.STRING },
        workflow: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              phase: { type: Type.STRING },
              description: { type: Type.STRING },
            },
            required: ['phase', 'description'],
          },
        },
      },
      required: ['monetization', 'teamStructure', 'workflow'],
    },
    actionableBlueprint: {
      type: Type.OBJECT,
      properties: {
        positioning: { type: Type.STRING },
        contentPillars: { type: Type.ARRAY, items: { type: Type.STRING } },
        executionSteps: { type: Type.ARRAY, items: { type: Type.STRING } },
        visualConcepts: {
          type: Type.OBJECT,
          properties: {
            avatarPrompt: { type: Type.STRING },
            coverStylePrompt: { type: Type.STRING },
          },
          required: ['avatarPrompt', 'coverStylePrompt'],
        },
      },
      required: ['positioning', 'contentPillars', 'executionSteps', 'visualConcepts'],
    },
    calculatedPlayCount: {
      type: Type.OBJECT,
      properties: {
        estimatedTotal: { type: Type.STRING },
        explanation: { type: Type.STRING },
      },
      required: ['estimatedTotal', 'explanation'],
    },
  },
  required: ['contentAnalysis', 'audioAnalysis', 'growthStrategy', 'audienceAnalysis', 'improvementPlan', 'operationalAnalysis', 'actionableBlueprint', 'calculatedPlayCount'],
};
