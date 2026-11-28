import { Type } from '@google/genai';

export function generalPrompt(videoTitle?: string): string {
  return `你是一个专业的短视频内容分析师和爆款制造机。
请分析我提供的视频${videoTitle ? `（标题为："${videoTitle}"）` : ''}，并输出以下维度的结构化分析结果：
1. 视频总体思路 (overallConcept)：按真实时长拆解核心概念、前3秒钩子机制（视觉/听觉抓手）、叙事结构（起/承/转/落点）、人物与关键商品一致性锚点、光影色温基调及声音设计。
2. 逆向视频生成提示词 (reversePrompt)：请严格按视频**真实切镜时间点**分段（不要套用固定 0-5s/5-10s 模板），输出一段【100%纯英文】的提示词（用于直接复制给 Veo / Sora / Runway 等 AI 视频大模型，**绝对不能包含任何中文字符**，结构标签也必须是英文）：
   [Overall Style, Lighting Palette & Temporal Tone (no buzzwords like 8K/masterpiece)]
   · Subject, Product & Scene Grounding: [Consistent appearance of recurring people/products, exact clothing/material anchors, environment & key light direction.]
   ● X.Xs-Y.Ys ([Shot Function / Title]): [Shot Size (CU/MS/WS/OTS) + Camera Angle + Specific Camera Movement (Static / Push In / Pull Out / Pan Left/Right / Tilt Up/Down / Orbit / Follow / Handheld / Dolly Zoom) + Concrete Visual Action + Audio/Speech Cue.]
   · (Continue sequentially across every actual cut until video end.)
   · Motion & Rendering Constraints: [Lighting continuity, lens texture, subject consistency notes.]
   1. Camera Control: [Concrete camera movement rhythm & stability notes.]
   2. Negative Prompt: [Artifacts/flicker/morphing/text distortion to avoid.]
3. 提示词中文翻译 (reversePromptTranslation)：请将上述纯英文提示词完整翻译成中文，保持相同分段与时间轴格式。
4. 逆向图片生成提示词 (imageReversePrompt)：请输出一段【100%纯英文】的**静态首帧/核心定格画面**生图提示词（适用于 Midjourney / Flux / 即梦等）。必须描述冻结瞬间的景别、机位、主体外观与定格姿态、前后景层次、材质细节及光源色温，**禁止**写入“then/turns/zooms in”等连续动态或运镜动词。
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
