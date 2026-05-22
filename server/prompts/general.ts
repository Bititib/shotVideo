import { Type } from '@google/genai';

export function generalPrompt(videoTitle?: string): string {
  return `你是一个专业的短视频内容分析师和爆款制造机。
请分析我提供的视频${videoTitle ? `（标题为："${videoTitle}"）` : ''}，并输出以下维度的结构化分析结果：
1. 视频总体思路：分析视频的核心概念、叙事手法、情感基调和吸引观众的"钩子"。
2. 逆向视频生成提示词 (reversePrompt)：请严格按照以下【时间轴与结构化排版】输出一段【100%纯英文】的提示词（这是为了让用户能直接一键复制给Veo/Sora/Runway等AI视频大模型使用，**绝对不能包含任何中文字符**，包括结构标签也必须是英文）：
   [Overall Style, e.g., Realistic slice-of-life / Sci-fi. Reference specific directors or aesthetics.]
   · Subject, Character Positioning & Scene: [Detailed description of core characters/objects, their exact positioning in the frame, environment, lighting.]
   ● 0-5s ([Shot Theme]): [Shot size, Camera angle, Camera movement, and Subject action/positioning.]
   · 5-10s ([Shot Theme]): [Shot size, Camera angle, Camera movement, and Subject action/positioning.]
   · X-Ys ([Shot Theme]): [Continue breaking down based on actual video length.]
   · Render Requirements: [Quality, texture, lighting.]
   1. Camera Shake: [Suggestions for camera movement.]
   2. Negative Prompt: [Suggested negative words.]
3. 提示词中文翻译 (reversePromptTranslation)：请将上述纯英文提示词完整翻译成中文，保持相同的排版格式。
4. 逆向图片生成提示词 (imageReversePrompt)：请输出一段【100%纯英文】的图片生成提示词（适用于Midjourney/Stable Diffusion等），描述视频中最具代表性的一帧画面。
5. 图片提示词中文翻译 (imageReversePromptTranslation)：将上述纯英文图片提示词完整翻译成中文。
6. 标题分析：${videoTitle ? '分析当前标题的优缺点，并提供改进建议。' : '因为没有提供标题，请根据视频内容建议3个吸引人的爆款标题。'}
7. 关键词建议：提供5-8个适合用于社交媒体分发的标签/关键词。
8. 相关热门话题：建议3-5个可以蹭热点或参与的社交媒体话题挑战。
9. 热门曲目/风格：推荐适合该视频氛围的BGM风格或具体曲目类型。`;
}

export const generalSchema = {
  type: Type.OBJECT,
  properties: {
    overallConcept: { type: Type.STRING, description: '视频总体思路' },
    reversePrompt: { type: Type.STRING, description: '纯英文逆向视频生成提示词' },
    reversePromptTranslation: { type: Type.STRING, description: '提示词的中文翻译' },
    imageReversePrompt: { type: Type.STRING, description: '纯英文逆向图片生成提示词' },
    imageReversePromptTranslation: { type: Type.STRING, description: '图片提示词的中文翻译' },
    titleAnalysis: { type: Type.STRING, description: '标题分析' },
    keywords: { type: Type.ARRAY, items: { type: Type.STRING }, description: '关键词建议' },
    hotTopics: { type: Type.ARRAY, items: { type: Type.STRING }, description: '相关热门话题' },
    hotMusicStyles: { type: Type.ARRAY, items: { type: Type.STRING }, description: '热门曲目/风格' },
  },
  required: ['overallConcept', 'reversePrompt', 'reversePromptTranslation', 'imageReversePrompt', 'imageReversePromptTranslation', 'titleAnalysis', 'keywords', 'hotTopics', 'hotMusicStyles'],
};
