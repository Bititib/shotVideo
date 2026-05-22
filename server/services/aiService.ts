import { GoogleGenAI, Type } from '@google/genai';
import fs from 'fs';
import { env, getNextApiKey } from '../config/env.js';
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

function getAI(modelConfig?: ModelConfig) {
  // 优先级: 渠道模型自带 Key > gemini 类型渠道 Key > env Key 池轮询
  if (modelConfig?.apiKey) return new GoogleGenAI({ apiKey: modelConfig.apiKey });

  const geminiChannel = ChannelService.findChannelByType('gemini');
  if (geminiChannel?.apiKey) return new GoogleGenAI({ apiKey: geminiChannel.apiKey });

  return new GoogleGenAI({ apiKey: getNextApiKey() });
}

export class AIService {
  /** 通用短视频分析 */
  static async analyzeGeneral(file: Express.Multer.File, videoTitle?: string, modelConfig?: ModelConfig) {
    const ai = getAI(modelConfig);
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';

    const uploadedFile = await this.uploadAndWait(ai, file);
    try {
      const prompt = generalPrompt(videoTitle);
      const response = await ai.models.generateContent({
        model: modelId,
        contents: [{ role: 'user', parts: [{ text: prompt }, { fileData: { fileUri: uploadedFile.uri, mimeType: uploadedFile.mimeType } }] }],
        config: { responseMimeType: 'application/json', responseSchema: generalSchema },
      });
      return JSON.parse(response.text || '{}');
    } finally {
      try { await ai.files.delete({ name: uploadedFile.name }); } catch {}
    }
  }

  /** 带货视频分析 */
  static async analyzeEcommerce(file: Express.Multer.File, videoTitle?: string, modelConfig?: ModelConfig) {
    const ai = getAI(modelConfig);
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';

    const uploadedFile = await this.uploadAndWait(ai, file);
    try {
      const prompt = ecommercePrompt(videoTitle);
      const response = await ai.models.generateContent({
        model: modelId,
        contents: [{ role: 'user', parts: [{ text: prompt }, { fileData: { fileUri: uploadedFile.uri, mimeType: uploadedFile.mimeType } }] }],
        config: { responseMimeType: 'application/json', responseSchema: ecommerceSchema },
      });
      return JSON.parse(response.text || '{}');
    } finally {
      try { await ai.files.delete({ name: uploadedFile.name }); } catch {}
    }
  }

  /** 图片逆向分析 */
  static async analyzeImage(file: Express.Multer.File, requiresText: boolean, modelConfig?: ModelConfig) {
    const ai = getAI(modelConfig);
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';

    const uploadedFile = await this.uploadAndWait(ai, file);
    try {
      const prompt = imagePrompt(requiresText);
      const response = await ai.models.generateContent({
        model: modelId,
        contents: [{ role: 'user', parts: [{ text: prompt }, { fileData: { fileUri: uploadedFile.uri, mimeType: uploadedFile.mimeType } }] }],
        config: { responseMimeType: 'application/json', responseSchema: imageSchema },
      });
      return JSON.parse(response.text || '{}');
    } finally {
      try { await ai.files.delete({ name: uploadedFile.name }); } catch {}
    }
  }

  /** 电商文案生成 */
  static async analyzeCopywriting(files: Express.Multer.File[], modelConfig?: ModelConfig) {
    const ai = getAI(modelConfig);
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';

    const uploadedFiles = await Promise.all(files.map(f => this.uploadAndWait(ai, f)));
    try {
      const fileParts = uploadedFiles.map(f => ({ fileData: { fileUri: f.uri, mimeType: f.mimeType } }));
      const response = await ai.models.generateContent({
        model: modelId,
        contents: [{ role: 'user', parts: [{ text: copywritingPrompt() }, ...fileParts] }],
        config: { responseMimeType: 'application/json', responseSchema: copywritingSchema },
      });
      return JSON.parse(response.text || '{}');
    } finally {
      for (const f of uploadedFiles) { try { await ai.files.delete({ name: f.name }); } catch {} }
    }
  }

  /** 账号全方位分析 */
  static async analyzeAccount(handle: string, description: string, files: Express.Multer.File[], modelConfig?: ModelConfig) {
    const ai = getAI(modelConfig);
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';

    const uploadedFiles = await Promise.all(files.map(f => this.uploadAndWait(ai, f)));
    try {
      const fileParts = uploadedFiles.map(f => ({ fileData: { fileUri: f.uri, mimeType: f.mimeType } }));
      const prompt = accountPrompt(handle, description);
      const response = await ai.models.generateContent({
        model: modelId,
        contents: [{ role: 'user', parts: [{ text: prompt }, ...fileParts] }],
        config: { responseMimeType: 'application/json', responseSchema: accountSchema },
      });
      return JSON.parse(response.text || '{}');
    } finally {
      for (const f of uploadedFiles) { try { await ai.files.delete({ name: f.name }); } catch {} }
    }
  }

  /** 换品修改提示词 */
  static async modifyPrompt(file: Express.Multer.File, existingPrompt: string, modelConfig?: ModelConfig) {
    const ai = getAI(modelConfig);
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash';

    const uploadedFile = await this.uploadAndWait(ai, file);
    try {
      const prompt = modifyPromptTemplate(existingPrompt);
      const response = await ai.models.generateContent({
        model: modelId,
        contents: [{ role: 'user', parts: [{ text: prompt }, { fileData: { fileUri: uploadedFile.uri, mimeType: uploadedFile.mimeType } }] }],
        config: { responseMimeType: 'application/json', responseSchema: modifyPromptSchema },
      });
      return JSON.parse(response.text || '{}');
    } finally {
      try { await ai.files.delete({ name: uploadedFile.name }); } catch {}
    }
  }

  /** AI 图像生成 */
  static async generateImage(prompt: string, aspectRatio: string, referenceFile?: Express.Multer.File, modelConfig?: ModelConfig) {
    const ai = getAI(modelConfig);
    const modelId = modelConfig?.modelId || 'gemini-2.5-flash-image';

    let parts: any[] = [{ text: prompt }];

    if (referenceFile) {
      const fileData = fs.readFileSync(referenceFile.path);
      const base64 = fileData.toString('base64');
      parts = [
        { inlineData: { data: base64, mimeType: referenceFile.mimetype } },
        { text: `Using the provided image as the core product reference, generate a high-quality product photography scene: ${prompt}` },
      ];
    }

    const response = await ai.models.generateContent({
      model: modelId,
      contents: { parts },
      config: { imageConfig: { aspectRatio } },
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return { imageBase64: part.inlineData.data, mimeType: 'image/png' };
      }
    }
    throw new Error('图像生成失败');
  }

  // === 工具函数 ===

  private static async uploadAndWait(ai: GoogleGenAI, file: Express.Multer.File) {
    const fileBlob = new Blob([fs.readFileSync(file.path)], { type: file.mimetype });
    const uploadFile = new File([fileBlob], file.originalname, { type: file.mimetype });

    let uploadedFile = await ai.files.upload({
      file: uploadFile,
      config: { mimeType: file.mimetype },
    });

    while (uploadedFile.state === 'PROCESSING') {
      await new Promise(resolve => setTimeout(resolve, 2000));
      uploadedFile = await ai.files.get({ name: uploadedFile.name });
    }

    if (uploadedFile.state === 'FAILED') {
      throw new Error('文件处理失败，请尝试其他文件。');
    }

    // 清理临时文件
    try { fs.unlinkSync(file.path); } catch {}

    return uploadedFile;
  }
}
