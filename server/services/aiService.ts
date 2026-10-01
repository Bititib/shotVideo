import { Type } from '@google/genai';
import fs from 'fs';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { env } from '../config/env.js';
import { loadTtsVoiceCatalog } from './ttsCatalogService.js';
import { ChannelService } from './channelService.js';
import { generalPrompt, generalSchema } from '../prompts/general.js';
import { ecommercePrompt, ecommerceSchema } from '../prompts/ecommerce.js';
import { imagePrompt, imageSchema } from '../prompts/image.js';
import { copywritingPrompt, copywritingSchema } from '../prompts/copywriting.js';
import { accountPrompt, accountSchema } from '../prompts/account.js';
import { modifyPromptTemplate, modifyPromptSchema } from '../prompts/ecommerce.js';
import {
  buildScriptBlocks, seriesPlanningPrompt, seriesPlanningSchema,
  storyboardDirectorPrompt, storyboardDirectorSchema, visualBiblePrompt, visualBibleSchema,
  videoQualityPrompt, videoQualitySchema, visualQualityPrompt, visualQualitySchema,
} from '../prompts/comicDrama.js';

interface ModelConfig {
  id: number;
  modelId: string;
  apiKey: string | null;
}

function getApiKey(modelConfig?: ModelConfig): string {
  if (modelConfig?.apiKey) return modelConfig.apiKey;
  const geminiChannel = ChannelService.findChannelByType('gemini');
  if (geminiChannel?.apiKey) return geminiChannel.apiKey;
  return env.GEMINI_API_KEY;
}

export class AIService {
  /** 整剧分集策划：AI 只选择原文段落边界，服务端负责无损重建每集原文。 */
  static async planComicDramaSeries(script: string, input: { targetDuration?: number; requestedEpisodes?: number }, modelConfig?: ModelConfig) {
    const blocks = buildScriptBlocks(script);
    if (!blocks.length) throw new Error('剧本没有可识别的正文');
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';
    const response = await this.callGenerateContent(modelId, {
      contents: [{ role: 'user', parts: [{ text: seriesPlanningPrompt(script, input) }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: seriesPlanningSchema },
    }, modelConfig);
    const plan = JSON.parse(response.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    let proposed = Array.isArray(plan.episodes) ? plan.episodes.slice(0, 100) : [];
    if (!proposed.length) {
      const count = Math.max(1, Math.min(100, input.requestedEpisodes || Math.ceil(script.length / 12000)));
      proposed = Array.from({ length: count }, (_, index) => ({
        episodeNumber: index + 1, title: `第${index + 1}集`, summary: '', hook: '',
        endBlock: Math.round((index + 1) * blocks.length / count), estimatedDuration: input.targetDuration || 90,
      }));
    }
    proposed.sort((a: any, b: any) => Number(a.episodeNumber || a.startBlock || 0) - Number(b.episodeNumber || b.startBlock || 0));
    const ranges: Array<{ source: any; start: number; end: number }> = []; let previousEnd = 0;
    for (let index = 0; index < proposed.length && previousEnd < blocks.length; index++) {
      const remaining = proposed.length - index - 1;
      const maxEnd = Math.max(previousEnd + 1, blocks.length - remaining);
      const requestedEnd = index === proposed.length - 1 ? blocks.length : Math.round(Number(proposed[index].endBlock || maxEnd));
      const end = Math.max(previousEnd + 1, Math.min(maxEnd, requestedEnd));
      ranges.push({ source: proposed[index], start: previousEnd + 1, end }); previousEnd = end;
    }
    if (previousEnd < blocks.length) ranges.push({ source: proposed[proposed.length - 1] || {}, start: previousEnd + 1, end: blocks.length });

    const episodes: any[] = [];
    for (const range of ranges) {
      const groups: Array<typeof blocks> = []; let group: typeof blocks = []; let length = 0;
      for (const block of blocks.slice(range.start - 1, range.end)) {
        if (group.length && length + block.text.length + 2 > 45000) { groups.push(group); group = []; length = 0; }
        group.push(block); length += block.text.length + 2;
      }
      if (group.length) groups.push(group);
      groups.forEach((part, partIndex) => {
        const suffix = groups.length > 1 ? `（${partIndex + 1}）` : '';
        const episodeScript = part.map(block => block.text).join('\n\n');
        episodes.push({
          episodeNumber: episodes.length + 1, title: `${range.source.title || `第${episodes.length + 1}集`}${suffix}`,
          summary: range.source.summary || '', hook: range.source.hook || '',
          startBlock: part[0].id, endBlock: part[part.length - 1].id,
          estimatedDuration: Number(range.source.estimatedDuration || input.targetDuration || 90),
          characterCount: episodeScript.length, script: episodeScript,
        });
      });
    }
    return { title: plan.title || '未命名漫剧', logline: plan.logline || '', genre: plan.genre || '', visualStyle: plan.visualStyle || '', totalCharacters: script.length, episodes };
  }

  /** 将纯文本剧本拆成角色、场景和可生产的镜头蓝图。 */
  static async analyzeComicDramaScript(script: string, modelConfig?: ModelConfig, projectContext?: unknown) {
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';
    const bibleResponse = await this.callGenerateContent(modelId, {
      contents: [{ role: 'user', parts: [{ text: visualBiblePrompt(script, projectContext) }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: visualBibleSchema,
      },
    }, modelConfig);
    const visualBible = JSON.parse(bibleResponse.candidates?.[0]?.content?.parts?.[0]?.text || '{}');

    const storyboardResponse = await this.callGenerateContent(modelId, {
      contents: [{ role: 'user', parts: [{ text: storyboardDirectorPrompt(script, visualBible) }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: storyboardDirectorSchema },
    }, modelConfig);
    const storyboard = JSON.parse(storyboardResponse.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
    const shotsByScene = new Map((storyboard.scenes || []).map((scene: any) => [Number(scene.sceneNumber), scene.shots || []]));
    return { ...visualBible, scenes: (visualBible.scenes || []).map((scene: any) => {
      let previousEnd = '';
      const sourceShots = shotsByScene.get(Number(scene.sceneNumber)) as any[] | undefined;
      const shots = (sourceShots || []).map((shot: any) => {
        const normalized = { ...shot, continuityStart: previousEnd || shot.continuityStart || '', continuityEnd: shot.continuityEnd || '' };
        previousEnd = normalized.continuityEnd;
        return normalized;
      });
      return { ...scene, shots };
    }) };
  }

  /** 视觉质检 Agent：对生成图片评分并给出可直接重试的修正提示词。 */
  static async reviewComicDramaImage(input: {
    imageUrl: string; kind: string; name: string; expectedPrompt: string; visualStyle: string;
  }, modelConfig?: ModelConfig) {
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';
    const imagePart = await this.loadImagePart(input.imageUrl);
    const response = await this.callGenerateContent(modelId, {
      contents: [{ role: 'user', parts: [{ text: visualQualityPrompt(input) }, imagePart] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: visualQualitySchema },
    }, modelConfig);
    return JSON.parse(response.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
  }

  /** 视频质检 Agent：检查变脸、闪烁、动作完整性和镜头首尾连续性。 */
  static async reviewComicDramaVideo(input: {
    videoUrl: string; name: string; expectedPrompt: string; continuityStart?: string; continuityEnd?: string; visualStyle: string;
  }, modelConfig?: ModelConfig) {
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';
    const videoPart = await this.loadVideoPart(input.videoUrl);
    const response = await this.callGenerateContent(modelId, {
      contents: [{ role: 'user', parts: [{ text: videoQualityPrompt(input) }, videoPart] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: videoQualitySchema },
    }, modelConfig);
    return JSON.parse(response.candidates?.[0]?.content?.parts?.[0]?.text || '{}');
  }

  private static async loadImagePart(source: string) {
    if (source.startsWith('data:image/')) {
      const match = source.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
      if (!match) throw new Error('质检图片格式不正确');
      if (Buffer.byteLength(match[2], 'base64') > 12 * 1024 * 1024) throw new Error('质检图片超过 12MB');
      return { inlineData: { mimeType: match[1], data: match[2] } };
    }
    if (source.startsWith('/uploads/')) {
      const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads');
      const candidate = path.resolve(uploadsRoot, decodeURIComponent(source.slice('/uploads/'.length)).replace(/^[/\\]+/, ''));
      if (!candidate.startsWith(`${uploadsRoot}${path.sep}`) || !fs.existsSync(candidate)) throw new Error('质检图片不存在');
      const buffer = fs.readFileSync(candidate);
      if (buffer.length > 12 * 1024 * 1024) throw new Error('质检图片超过 12MB');
      const extension = path.extname(candidate).toLowerCase();
      const mimeType = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg';
      return { inlineData: { mimeType, data: buffer.toString('base64') } };
    }
    const url = new URL(source);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('质检图片地址不受支持');
    await this.assertPublicImageHost(url.hostname);
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000), redirect: 'error' });
    if (!res.ok) throw new Error(`质检图片下载失败 (${res.status})`);
    const mimeType = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    if (!mimeType.startsWith('image/')) throw new Error('质检地址没有返回图片');
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > 12 * 1024 * 1024) throw new Error('质检图片超过 12MB');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 12 * 1024 * 1024) throw new Error('质检图片超过 12MB');
    return { inlineData: { mimeType, data: buffer.toString('base64') } };
  }

  private static async loadVideoPart(source: string) {
    const maxBytes = 30 * 1024 * 1024;
    if (source.startsWith('/api/uploads/')) source = source.slice(4);
    if (source.startsWith('data:video/')) {
      const match = source.match(/^data:(video\/[a-zA-Z0-9.+-]+);base64,(.+)$/s);
      if (!match) throw new Error('质检视频格式不正确');
      if (Buffer.byteLength(match[2], 'base64') > maxBytes) throw new Error('质检视频超过 30MB');
      return { inlineData: { mimeType: match[1], data: match[2] } };
    }
    if (source.startsWith('/uploads/')) {
      const uploadsRoot = path.resolve(process.cwd(), 'data', 'uploads');
      const candidate = path.resolve(uploadsRoot, decodeURIComponent(source.slice('/uploads/'.length)).replace(/^[/\\]+/, ''));
      if (!candidate.startsWith(`${uploadsRoot}${path.sep}`) || !fs.existsSync(candidate)) throw new Error('质检视频不存在');
      const buffer = fs.readFileSync(candidate);
      if (buffer.length > maxBytes) throw new Error('质检视频超过 30MB');
      const extension = path.extname(candidate).toLowerCase();
      const mimeType = extension === '.webm' ? 'video/webm' : extension === '.mov' ? 'video/quicktime' : 'video/mp4';
      return { inlineData: { mimeType, data: buffer.toString('base64') } };
    }
    const url = new URL(source);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('质检视频地址不受支持');
    await this.assertPublicImageHost(url.hostname);
    const res = await fetch(url, { signal: AbortSignal.timeout(45_000), redirect: 'error' });
    if (!res.ok) throw new Error(`质检视频下载失败 (${res.status})`);
    const mimeType = (res.headers.get('content-type') || 'video/mp4').split(';')[0];
    if (!mimeType.startsWith('video/')) throw new Error('质检地址没有返回视频');
    const declared = Number(res.headers.get('content-length') || 0);
    if (declared > maxBytes) throw new Error('质检视频超过 30MB');
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('质检视频超过 30MB');
    return { inlineData: { mimeType, data: buffer.toString('base64') } };
  }

  private static async assertPublicImageHost(hostname: string) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.local')) throw new Error('质检图片地址不安全');
    const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
    const isPrivate = (address: string) => {
      const value = address.toLowerCase();
      if (value === '::1' || value === '::' || value.startsWith('fc') || value.startsWith('fd') || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')) return true;
      const mapped = value.startsWith('::ffff:') ? value.slice(7) : value;
      const parts = mapped.split('.').map(Number);
      if (parts.length !== 4 || parts.some(Number.isNaN)) return false;
      return parts[0] === 0 || parts[0] === 10 || parts[0] === 127 || parts[0] >= 224
        || (parts[0] === 169 && parts[1] === 254) || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
        || (parts[0] === 192 && parts[1] === 168);
    };
    if (!addresses.length || addresses.some(item => isPrivate(item.address))) throw new Error('质检图片地址不安全');
  }

  /** 核心接口调用：请求 Gemini 的 generateContent 端点 */
  static async callGenerateContent(modelId: string, payload: any, modelConfig?: ModelConfig) {
    const apiKey = getApiKey(modelConfig);
    const url = `${env.GEMINI_API_BASE_URL}/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Gemini API 呼叫失败: ${res.status} ${res.statusText} - ${text}`);
    }

    return await res.json();
  }

  /** 通用短视频分析 */
  static async analyzeGeneral(file: Express.Multer.File, videoTitle?: string, modelConfig?: ModelConfig) {
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';
    const uploadedFile = await this.uploadAndWait(file, modelConfig);
    try {
      const prompt = generalPrompt(videoTitle);
      const response = await this.callGenerateContent(modelId, {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { fileData: { fileUri: uploadedFile.uri, mimeType: uploadedFile.mimeType } }
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: generalSchema,
        }
      }, modelConfig);

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return JSON.parse(text);
    } finally {
      await this.deleteUploadedFile(uploadedFile.name, modelConfig);
    }
  }

  /** 带货视频分析 */
  static async analyzeEcommerce(file: Express.Multer.File, videoTitle?: string, modelConfig?: ModelConfig) {
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';
    const uploadedFile = await this.uploadAndWait(file, modelConfig);
    try {
      const prompt = ecommercePrompt(videoTitle);
      const response = await this.callGenerateContent(modelId, {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { fileData: { fileUri: uploadedFile.uri, mimeType: uploadedFile.mimeType } }
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: ecommerceSchema,
        }
      }, modelConfig);

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return JSON.parse(text);
    } finally {
      await this.deleteUploadedFile(uploadedFile.name, modelConfig);
    }
  }

  /** 图片逆向分析 */
  static async analyzeImage(file: Express.Multer.File, requiresText: boolean, modelConfig?: ModelConfig) {
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';
    const uploadedFile = await this.uploadAndWait(file, modelConfig);
    try {
      const prompt = imagePrompt(requiresText);
      const response = await this.callGenerateContent(modelId, {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { fileData: { fileUri: uploadedFile.uri, mimeType: uploadedFile.mimeType } }
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: imageSchema,
        }
      }, modelConfig);

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return JSON.parse(text);
    } finally {
      await this.deleteUploadedFile(uploadedFile.name, modelConfig);
    }
  }

  /** 电商文案生成 */
  static async analyzeCopywriting(files: Express.Multer.File[], modelConfig?: ModelConfig) {
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';
    const uploadedFiles: Array<{ uri: string; name: string; mimeType: string }> = [];
    try {
      // AI Studio proxies may support inline images but reject the Files upload protocol.
      const fileParts: any[] = [];
      let inlineBytes = 0;
      for (const file of files) {
        if (file.mimetype.startsWith('image/')) {
          inlineBytes += Math.ceil(fs.statSync(file.path).size / 3) * 4;
          if (inlineBytes > 18_000_000) throw { status: 400, message: '产品图片总大小过大，请压缩图片或减少图片数量后重试。' };
          fileParts.push({ inlineData: { mimeType: file.mimetype, data: fs.readFileSync(file.path).toString('base64') } });
        } else {
          const uploaded = await this.uploadAndWait(file, modelConfig);
          uploadedFiles.push(uploaded);
          fileParts.push({ fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } });
        }
      }
      const response = await this.callGenerateContent(modelId, {
        contents: [{
          role: 'user',
          parts: [
            { text: copywritingPrompt() },
            ...fileParts
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: copywritingSchema,
        }
      }, modelConfig);

      const candidate = response.candidates?.[0];
      const text = (candidate?.content?.parts || []).filter((part: any) => !part.thought && typeof part.text === 'string').map((part: any) => part.text).join('').trim();
      if (!text) throw new Error('上游未返回文案内容，素材可能被拦截，请更换素材或模型后重试。');
      if (candidate?.finishReason === 'MAX_TOKENS') throw new Error('上游返回的文案不完整，请减少素材或更换模型后重试。');
      try {
        return JSON.parse(text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
      } catch {
        throw new Error('上游返回的文案格式不正确，请重试或更换模型。');
      }
    } finally {
      for (const file of files) {
        try { fs.unlinkSync(file.path); } catch {}
      }
      for (const f of uploadedFiles) {
        await this.deleteUploadedFile(f.name, modelConfig);
      }
    }
  }

  /** 账号全方位分析 */
  static async analyzeAccount(handle: string, description: string, files: Express.Multer.File[], modelConfig?: ModelConfig) {
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';
    const uploadedFiles = await Promise.all(files.map(f => this.uploadAndWait(f, modelConfig)));
    try {
      const fileParts = uploadedFiles.map(f => ({ fileData: { fileUri: f.uri, mimeType: f.mimeType } }));
      const prompt = accountPrompt(handle, description);
      const response = await this.callGenerateContent(modelId, {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            ...fileParts
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: accountSchema,
        }
      }, modelConfig);

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return JSON.parse(text);
    } finally {
      for (const f of uploadedFiles) {
        await this.deleteUploadedFile(f.name, modelConfig);
      }
    }
  }

  /** 换品修改提示词 */
  static async modifyPrompt(file: Express.Multer.File, existingPrompt: string, modelConfig?: ModelConfig) {
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';
    const uploadedFile = await this.uploadAndWait(file, modelConfig);
    try {
      const prompt = modifyPromptTemplate(existingPrompt);
      const response = await this.callGenerateContent(modelId, {
        contents: [{
          role: 'user',
          parts: [
            { text: prompt },
            { fileData: { fileUri: uploadedFile.uri, mimeType: uploadedFile.mimeType } }
          ]
        }],
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: modifyPromptSchema,
        }
      }, modelConfig);

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return JSON.parse(text);
    } finally {
      await this.deleteUploadedFile(uploadedFile.name, modelConfig);
    }
  }

  /** AI 图像生成 — 使用代理端图像生成接口 */
  static async generateImage(prompt: string, aspectRatio: string, referenceFile?: Express.Multer.File, modelConfig?: ModelConfig) {
    const modelId = modelConfig?.modelId || 'gemini-3-pro-image';
    const apiKey = getApiKey(modelConfig);
    // 代理端图片生成模型需要 models%2F 前缀
    const url = `${env.GEMINI_API_BASE_URL}/v1beta/models/models%2F${modelId}:generateContent?key=${apiKey}`;

    let parts: any[] = [{ text: `${prompt} (aspect ratio: ${aspectRatio})` }];

    if (referenceFile) {
      const fileData = fs.readFileSync(referenceFile.path);
      const base64 = fileData.toString('base64');
      parts = [
        { inlineData: { data: base64, mimeType: referenceFile.mimetype } },
        { text: `Using the provided image as the core product reference, generate a high-quality product photography scene: ${prompt} (aspect ratio: ${aspectRatio})` },
      ];
      try { fs.unlinkSync(referenceFile.path); } catch {}
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ contents: [{ role: 'user', parts }] }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (res.status === 429) {
        throw new Error('AI 图像生成频率超限，请稍后再试');
      }
      throw new Error(`图像生成接口调用失败: ${res.status} - ${errText}`);
    }

    const response = await res.json() as any;

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return { imageBase64: part.inlineData.data, mimeType: part.inlineData.mimeType || 'image/png' };
      }
    }
    throw new Error('图像生成失败：未返回图片数据');
  }

  static getTtsVoiceCatalog() {
    return loadTtsVoiceCatalog(env.GEMINI_API_BASE_URL, getApiKey());
  }

  /** AIStudio2API Gemini-compatible speech configuration (including Gemini 3.8). */
  static async generateTts(text: string, voice: string, modelConfig?: ModelConfig) {
    if (!modelConfig?.modelId) throw new Error('请先选择可用的语音模型');
    const modelId = modelConfig.modelId;
    const apiKey = getApiKey(modelConfig);
    const url = `${env.GEMINI_API_BASE_URL}/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text }]
        }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`TTS 接口调用失败: ${res.status} - ${errText}`);
    }

    const response = await res.json();

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        const rawMime: string = part.inlineData.mimeType || '';
        const rawBase64: string = part.inlineData.data;

        // Gemini TTS 返回 audio/L16;codec=pcm;rate=24000（原始 PCM），
        // 浏览器 <audio> 无法直接播放原始 PCM，需要封装为 WAV
        if (rawMime.includes('pcm') || rawMime.includes('L16')) {
          const sampleRate = parseInt(rawMime.match(/rate=(\d+)/)?.[1] || '24000', 10);
          const wavBase64 = this.pcmToWavBase64(rawBase64, sampleRate);
          return { audioBase64: wavBase64, mimeType: 'audio/wav' };
        }

        return { audioBase64: rawBase64, mimeType: rawMime || 'audio/wav' };
      }
    }
    throw new Error('语音合成失败：未返回音频数据');
  }

  /** 将原始 PCM base64 封装为 WAV base64（添加 44 字节 WAV header） */
  private static pcmToWavBase64(pcmBase64: string, sampleRate: number, numChannels = 1, bitsPerSample = 16): string {
    const pcmBuffer = Buffer.from(pcmBase64, 'base64');
    const dataSize = pcmBuffer.length;
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
    const blockAlign = numChannels * (bitsPerSample / 8);

    // 44 字节 WAV header
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);                          // ChunkID
    header.writeUInt32LE(36 + dataSize, 4);            // ChunkSize
    header.write('WAVE', 8);                           // Format
    header.write('fmt ', 12);                          // Subchunk1ID
    header.writeUInt32LE(16, 16);                      // Subchunk1Size (PCM)
    header.writeUInt16LE(1, 20);                       // AudioFormat (1 = PCM)
    header.writeUInt16LE(numChannels, 22);              // NumChannels
    header.writeUInt32LE(sampleRate, 24);               // SampleRate
    header.writeUInt32LE(byteRate, 28);                 // ByteRate
    header.writeUInt16LE(blockAlign, 32);               // BlockAlign
    header.writeUInt16LE(bitsPerSample, 34);            // BitsPerSample
    header.write('data', 36);                          // Subchunk2ID
    header.writeUInt32LE(dataSize, 40);                 // Subchunk2Size

    const wavBuffer = Buffer.concat([header, pcmBuffer]);
    return wavBuffer.toString('base64');
  }

  // === 内部工具函数 ===

  private static async uploadAndWait(file: Express.Multer.File, modelConfig?: ModelConfig) {
    const apiKey = getApiKey(modelConfig);
    const filePath = file.path;
    const fileSize = fs.statSync(filePath).size;
    const mimeType = file.mimetype;
    const displayName = file.originalname;

    // Step 1: 开启分片/可断点上传会话
    const startUrl = `${env.GEMINI_API_BASE_URL}/upload/v1beta/files?key=${apiKey}`;
    const startRes = await fetch(startUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Protocol': 'resumable',
        'X-Goog-Upload-Command': 'start',
        'X-Goog-Upload-Header-Content-Length': fileSize.toString(),
        'X-Goog-Upload-Header-Content-Type': mimeType,
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        file: { display_name: displayName }
      })
    });

    if (!startRes.ok) {
      const text = await startRes.text();
      throw new Error(`启动文件上传失败: ${startRes.status} ${startRes.statusText} - ${text}`);
    }

    const uploadUrl = startRes.headers.get('x-goog-upload-url') || startRes.headers.get('location');
    if (!uploadUrl) {
      throw new Error('未在响应头中获取到 x-goog-upload-url 或 location');
    }

    // Step 2: 上传文件二进制内容
    const fileBuffer = fs.readFileSync(filePath);
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
        'Content-Length': fileSize.toString(),
        'Authorization': `Bearer ${apiKey}`,
      },
      body: fileBuffer,
    });

    if (!uploadRes.ok) {
      const text = await uploadRes.text();
      throw new Error(`上传文件数据失败: ${uploadRes.status} ${uploadRes.statusText} - ${text}`);
    }

    const fileInfo = await uploadRes.json() as any;
    const fileName = fileInfo.file?.name || fileInfo.name;
    const fileUri = fileInfo.file?.uri || fileInfo.uri;

    if (!fileName) {
      throw new Error('上传成功但返回的响应中不含 name');
    }

    // Step 3: 轮询视频文件处理状态
    if (mimeType.startsWith('video/')) {
      // fileName 可能是 "files/xxx" 或 "xxx"，需要统一处理路径
      const fileId = fileName.startsWith('files/') ? fileName.replace('files/', '') : fileName;
      let state = 'PROCESSING';
      let pollErrors = 0;
      while (state === 'PROCESSING') {
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
          const statusRes = await fetch(`${env.GEMINI_API_BASE_URL}/v1beta/files/${fileId}?key=${apiKey}`, {
            headers: {
              'Authorization': `Bearer ${apiKey}`,
            }
          });
          if (statusRes.ok) {
            const statusInfo = await statusRes.json() as any;
            state = statusInfo.state;
            if (state === 'FAILED') {
              throw new Error('文件在 Gemini 端处理失败。');
            }
            pollErrors = 0; // 重置错误计数
          } else {
            pollErrors++;
            console.warn(`[uploadAndWait] 文件状态查询失败 (${pollErrors}/3): ${statusRes.status}`);
            if (pollErrors >= 3) {
              // 代理端可能不支持文件状态查询，直接跳过轮询
              console.warn('[uploadAndWait] 跳过文件状态轮询，直接使用文件');
              state = 'ACTIVE';
            }
          }
        } catch (e: any) {
          if (e.message?.includes('文件在 Gemini 端处理失败')) throw e;
          pollErrors++;
          console.warn(`[uploadAndWait] 轮询异常 (${pollErrors}/3):`, e.message);
          if (pollErrors >= 3) {
            console.warn('[uploadAndWait] 跳过文件状态轮询，直接使用文件');
            state = 'ACTIVE';
          }
        }
      }
    }

    // 清理本地临时文件
    try { fs.unlinkSync(filePath); } catch {}

    return { uri: fileUri, name: fileName, mimeType };
  }

  private static async deleteUploadedFile(fileName: string, modelConfig?: ModelConfig) {
    try {
      const apiKey = getApiKey(modelConfig);
      const fileId = fileName.startsWith('files/') ? fileName.replace('files/', '') : fileName;
      const url = `${env.GEMINI_API_BASE_URL}/v1beta/files/${fileId}?key=${apiKey}`;
      await fetch(url, {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
        },
      });
    } catch (e) {
      console.error('[deleteFile] 警告: 清理云端临时文件失败:', e);
    }
  }
}
