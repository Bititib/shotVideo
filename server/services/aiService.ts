import { Type } from '@google/genai';
import fs from 'fs';
import { env } from '../config/env.js';
import { ChannelService } from './channelService.js';
import { generalPrompt, generalSchema } from '../prompts/general.js';
import { ecommercePrompt, ecommerceSchema } from '../prompts/ecommerce.js';
import { imagePrompt, imageSchema } from '../prompts/image.js';
import { copywritingPrompt, copywritingSchema } from '../prompts/copywriting.js';
import { accountPrompt, accountSchema } from '../prompts/account.js';
import { modifyPromptTemplate, modifyPromptSchema } from '../prompts/ecommerce.js';

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
    const uploadedFiles = await Promise.all(files.map(f => this.uploadAndWait(f, modelConfig)));
    try {
      const fileParts = uploadedFiles.map(f => ({ fileData: { fileUri: f.uri, mimeType: f.mimeType } }));
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

      const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
      return JSON.parse(text);
    } finally {
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

  /** 语音合成 (TTS) — 使用代理端专用 TTS 接口 */
  static async generateTts(text: string, voice: string, modelConfig?: ModelConfig) {
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash-preview-tts';
    const apiKey = getApiKey(modelConfig);
    const url = `${env.GEMINI_API_BASE_URL}/v1beta/models/${modelId}:generateContent?key=${apiKey}`;
    const payloadText = `Use ${voice} voice: ${text}`;

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: payloadText }]
        }]
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
