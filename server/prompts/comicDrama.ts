import { Type } from '@google/genai';

export type ScriptBlock = { id: number; text: string };

export function buildScriptBlocks(script: string): ScriptBlock[] {
  const normalized = script.replace(/\r\n?/g, '\n').trim();
  let paragraphs = normalized.split(/\n\s*\n+/).map(value => value.trim()).filter(Boolean);
  if (paragraphs.length < 3) {
    const lines = normalized.split('\n').map(value => value.trim()).filter(Boolean);
    paragraphs = [];
    for (let index = 0; index < lines.length; index += 8) paragraphs.push(lines.slice(index, index + 8).join('\n'));
  }
  const chunks: string[] = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= 1600) { chunks.push(paragraph); continue; }
    for (let start = 0; start < paragraph.length; start += 1400) chunks.push(paragraph.slice(start, start + 1400));
  }
  return chunks.slice(0, 4000).map((text, index) => ({ id: index + 1, text }));
}

export function seriesPlanningPrompt(script: string, input: { targetDuration?: number; requestedEpisodes?: number } = {}) {
  const blocks = buildScriptBlocks(script);
  const numbered = blocks.map(block => `[B${String(block.id).padStart(4, '0')}]\n${block.text}`).join('\n\n');
  return `你是短篇漫剧的总编剧与分集策划。请将整部原始剧本规划为适合连续观看的多集短漫剧。
只能通过段落编号划分边界，不得改写、删减或重新输出原文。每个原文段落必须且只能归入一集。
每集目标时长约 ${input.targetDuration || 90} 秒；${input.requestedEpisodes ? `用户希望约 ${input.requestedEpisodes} 集。` : '请根据剧情节奏自动决定集数。'}
分集原则：每集有明确目标、冲突推进和结尾悬念；避免在一句台词或同一连续动作中间切断；单集原文尽量不超过 30000 字。
startBlock 和 endBlock 必须填写段落数字，例如 B0001 填写 1。第一集从 1 开始，最后一集覆盖最后一个段落，相邻集不得重叠。

带编号的原始剧本：
---
${numbered}
---`;
}

export const seriesPlanningSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING }, logline: { type: Type.STRING }, genre: { type: Type.STRING },
    visualStyle: { type: Type.STRING },
    episodes: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: {
      episodeNumber: { type: Type.NUMBER }, title: { type: Type.STRING }, summary: { type: Type.STRING },
      hook: { type: Type.STRING }, startBlock: { type: Type.NUMBER }, endBlock: { type: Type.NUMBER },
      estimatedDuration: { type: Type.NUMBER },
    }, required: ['episodeNumber', 'title', 'summary', 'hook', 'startBlock', 'endBlock', 'estimatedDuration'] } },
  },
  required: ['title', 'logline', 'genre', 'visualStyle', 'episodes'],
};

export function visualBiblePrompt(script: string, projectContext?: unknown): string {
  return `你是漫剧项目的视觉设定总监。阅读剧本后建立一份严格、可复用的视觉圣经。
固定每个角色的年龄感、脸型五官、发型、体型、服装、配色和辨识物；提取关键道具；为每个场景建立不含人物的环境设定。
所有资产提示词必须具体、可直接用于图片生成，并明确正视、侧视、全身、表情或空间结构。默认竖屏 9:16 漫剧，不改变原剧情。
若提供了全剧视觉上下文，必须沿用已有画风、角色身份、别名、服装版本、场景结构和道具设计，不得为同一对象另起一套设定。

全剧视觉上下文：${projectContext ? JSON.stringify(projectContext) : '首集，尚无既有设定'}

剧本：\n---\n${script}\n---`;
}

export function storyboardDirectorPrompt(script: string, visualBible: unknown): string {
  return `你是漫剧分镜导演。只能依据原剧本和视觉圣经拆分镜头，不得擅自改变角色造型或故事走向。
每镜只承载一个主要动作或情绪变化，建议 3-8 秒；明确景别、机位、运镜、人物位置、动作起止、台词和衔接。
imagePrompt 描述单帧画面并复用视觉圣经中的固定特征；videoPrompt 描述从该画面出发的动作、表演、运镜与节奏。
continuityStart 必须记录镜头开始时人物位置、朝向、服装、伤势、手持物和场景状态；continuityEnd 记录镜头结束状态，供下一镜继承。
打斗镜头必须把动作写成起势、攻击、闪避/格挡、命中反馈、收势中的一个明确节拍，禁止用“激烈打斗”等抽象描述代替动作。

视觉圣经：\n${JSON.stringify(visualBible)}

原剧本：\n---\n${script}\n---`;
}

export function visualQualityPrompt(input: { kind: string; name: string; expectedPrompt: string; visualStyle: string }): string {
  return `你是漫剧视觉质检 Agent。请对照制作要求审核图片，不要评价剧情。
检查：主体数量与身份、脸型发型服装、场景时间与光线、构图景别、关键道具、文字水印、手部肢体、画面破损。
给出 0-100 分；只有主体与设定一致、无明显结构错误且构图可用时 consistencyPassed 才能为 true。
若不通过，correctedPrompt 必须是可直接重新生成的完整提示词，明确保留项和修正项。

资产类型：${input.kind}
对象：${input.name}
统一视觉：${input.visualStyle}
预期画面：${input.expectedPrompt}`;
}

export function videoQualityPrompt(input: { name: string; expectedPrompt: string; continuityStart?: string; continuityEnd?: string; visualStyle: string }): string {
  return `你是漫剧视频质检 Agent。审核视频是否可以直接进入剪辑，不评价剧情。
检查：人物身份与脸部稳定、服装道具一致、肢体结构、动作是否完整、运镜是否符合要求、画面闪烁/变形/穿模、首尾连续性。
给出 0-100 分；只有无明显变脸闪烁、动作可读、首尾状态符合要求时 consistencyPassed 才能为 true。
若不通过，correctedPrompt 必须给出可直接重新生成的完整视频提示词，明确动作起点、过程、终点和需要抑制的问题。

镜头：${input.name}
统一视觉：${input.visualStyle}
预期视频：${input.expectedPrompt}
开始状态：${input.continuityStart || '未指定'}
结束状态：${input.continuityEnd || '未指定'}`;
}

const characterSchema = {
  type: Type.OBJECT,
  properties: {
    name: { type: Type.STRING }, role: { type: Type.STRING }, description: { type: Type.STRING },
    assetPrompt: { type: Type.STRING, description: '固定角色设定图提示词' },
  },
  required: ['name', 'role', 'description', 'assetPrompt'],
};

const propSchema = {
  type: Type.OBJECT,
  properties: { name: { type: Type.STRING }, description: { type: Type.STRING }, assetPrompt: { type: Type.STRING } },
  required: ['name', 'description', 'assetPrompt'],
};

export const visualBibleSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING }, logline: { type: Type.STRING }, genre: { type: Type.STRING },
    visualStyle: { type: Type.STRING }, estimatedDuration: { type: Type.NUMBER },
    characters: { type: Type.ARRAY, items: characterSchema },
    props: { type: Type.ARRAY, items: propSchema },
    scenes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sceneNumber: { type: Type.NUMBER }, title: { type: Type.STRING }, location: { type: Type.STRING },
          time: { type: Type.STRING }, summary: { type: Type.STRING }, assetPrompt: { type: Type.STRING },
        },
        required: ['sceneNumber', 'title', 'location', 'time', 'summary', 'assetPrompt'],
      },
    },
  },
  required: ['title', 'logline', 'genre', 'visualStyle', 'estimatedDuration', 'characters', 'props', 'scenes'],
};

const shotSchema = {
  type: Type.OBJECT,
  properties: {
    shotNumber: { type: Type.NUMBER }, duration: { type: Type.NUMBER }, shotSize: { type: Type.STRING },
    camera: { type: Type.STRING }, action: { type: Type.STRING }, dialogue: { type: Type.STRING },
    characters: { type: Type.ARRAY, items: { type: Type.STRING } }, imagePrompt: { type: Type.STRING },
    videoPrompt: { type: Type.STRING }, continuityStart: { type: Type.STRING }, continuityEnd: { type: Type.STRING },
  },
  required: ['shotNumber', 'duration', 'shotSize', 'camera', 'action', 'dialogue', 'characters', 'imagePrompt', 'videoPrompt', 'continuityStart', 'continuityEnd'],
};

export const storyboardDirectorSchema = {
  type: Type.OBJECT,
  properties: {
    scenes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: { sceneNumber: { type: Type.NUMBER }, shots: { type: Type.ARRAY, items: shotSchema } },
        required: ['sceneNumber', 'shots'],
      },
    },
  },
  required: ['scenes'],
};

export const visualQualitySchema = {
  type: Type.OBJECT,
  properties: {
    score: { type: Type.NUMBER }, consistencyPassed: { type: Type.BOOLEAN },
    summary: { type: Type.STRING }, issues: { type: Type.ARRAY, items: { type: Type.STRING } },
    correctedPrompt: { type: Type.STRING },
  },
  required: ['score', 'consistencyPassed', 'summary', 'issues', 'correctedPrompt'],
};

export const videoQualitySchema = visualQualitySchema;

export function comicDramaPrompt(script: string): string {
  return `你是一名专业的漫剧导演、编剧和 AI 制片人。请把用户提交的剧本拆解成可直接用于 AI 图片与视频生成的制作蓝图。

要求：
1. 不续写无关剧情，保留原剧本的核心冲突、人物关系和台词含义。
2. 自动识别角色、重要道具和场景。角色描述必须固定外貌、发型、服装、年龄感和辨识特征，方便跨镜头保持一致。
3. 按叙事节奏拆成场次，再拆成镜头。每个镜头建议 3-8 秒，只表现一个清晰动作或情绪变化。
4. imagePrompt 和 videoPrompt 使用中文，必须具体、可执行。imagePrompt 描述单帧画面；videoPrompt 描述从该画面出发的动作、运镜、节奏和表演，避免抽象词。
5. 给出统一的视觉风格、画幅和色彩方案。默认面向竖屏短漫剧。
6. 若原文信息不足，可以做最小合理补全，但不要改变故事走向。

用户剧本：
---
${script}
---`;
}

export const comicDramaSchema = {
  type: Type.OBJECT,
  properties: {
    title: { type: Type.STRING, description: '适合该漫剧的项目标题' },
    logline: { type: Type.STRING, description: '一句话故事梗概' },
    genre: { type: Type.STRING, description: '题材类型' },
    visualStyle: { type: Type.STRING, description: '统一美术风格、画幅、光影与色彩说明' },
    estimatedDuration: { type: Type.NUMBER, description: '预计成片总时长，单位秒' },
    characters: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          role: { type: Type.STRING },
          description: { type: Type.STRING },
          assetPrompt: { type: Type.STRING, description: '角色设定图生成提示词，含正面、侧面、全身和表情' },
        },
        required: ['name', 'role', 'description', 'assetPrompt'],
      },
    },
    props: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          description: { type: Type.STRING },
          assetPrompt: { type: Type.STRING },
        },
        required: ['name', 'description', 'assetPrompt'],
      },
    },
    scenes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          sceneNumber: { type: Type.NUMBER },
          title: { type: Type.STRING },
          location: { type: Type.STRING },
          time: { type: Type.STRING },
          summary: { type: Type.STRING },
          assetPrompt: { type: Type.STRING, description: '无人物的场景设定图生成提示词' },
          shots: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                shotNumber: { type: Type.NUMBER },
                duration: { type: Type.NUMBER },
                shotSize: { type: Type.STRING },
                camera: { type: Type.STRING },
                action: { type: Type.STRING },
                dialogue: { type: Type.STRING },
                characters: { type: Type.ARRAY, items: { type: Type.STRING } },
                imagePrompt: { type: Type.STRING },
                videoPrompt: { type: Type.STRING },
              },
              required: ['shotNumber', 'duration', 'shotSize', 'camera', 'action', 'dialogue', 'characters', 'imagePrompt', 'videoPrompt'],
            },
          },
        },
        required: ['sceneNumber', 'title', 'location', 'time', 'summary', 'assetPrompt', 'shots'],
      },
    },
  },
  required: ['title', 'logline', 'genre', 'visualStyle', 'estimatedDuration', 'characters', 'props', 'scenes'],
};
