import { api } from './client';

type TtsModel = { modelId: string; displayName: string; rate?: number };
let ttsModelCache: { token: string; expiresAt: number; data: TtsModel[] } | null = null;
let ttsModelRequest: { token: string; promise: Promise<TtsModel[]> } | null = null;

export const analysisApi = {
  /** 获取当前用户可用的模型列表 */
  getAvailableModels() {
    return api.get<{ modelId: string; displayName: string }[]>('/analysis/models');
  },

  /** 获取语音合成模型及费率 */
  getTtsModels() {
    const token = localStorage.getItem('token') || '';
    if (ttsModelCache?.token === token && ttsModelCache.expiresAt > Date.now()) {
      return Promise.resolve(ttsModelCache.data);
    }
    if (ttsModelRequest?.token === token) return ttsModelRequest.promise;
    const promise = api.get<TtsModel[]>('/analysis/tts-models')
      .then((data) => {
        ttsModelCache = { token, expiresAt: Date.now() + 30_000, data };
        return data;
      })
      .finally(() => {
        if (ttsModelRequest?.promise === promise) ttsModelRequest = null;
      });
    ttsModelRequest = { token, promise };
    return promise;
  },

  analyzeGeneral(file: File, videoTitle?: string, modelId?: string) {
    const formData = new FormData();
    formData.append('file', file);
    if (videoTitle) formData.append('videoTitle', videoTitle);
    if (modelId) formData.append('modelId', modelId);
    return api.post<any>('/analysis/general', formData);
  },

  analyzeEcommerce(file: File, videoTitle?: string, modelId?: string) {
    const formData = new FormData();
    formData.append('file', file);
    if (videoTitle) formData.append('videoTitle', videoTitle);
    if (modelId) formData.append('modelId', modelId);
    return api.post<any>('/analysis/ecommerce', formData);
  },

  analyzeImage(file: File, requiresText: boolean, modelId?: string) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('imageRequiresText', String(requiresText));
    if (modelId) formData.append('modelId', modelId);
    return api.post<any>('/analysis/image', formData);
  },

  analyzeCopywriting(files: File[], modelId?: string) {
    const formData = new FormData();
    files.forEach(f => formData.append('files', f));
    if (modelId) formData.append('modelId', modelId);
    return api.post<any>('/analysis/copywriting', formData);
  },

  analyzeAccount(handle: string, description: string, files: File[], modelId?: string) {
    const formData = new FormData();
    formData.append('accountHandle', handle);
    formData.append('accountDescription', description);
    files.forEach(f => formData.append('files', f));
    if (modelId) formData.append('modelId', modelId);
    return api.post<any>('/analysis/account', formData);
  },

  modifyPrompt(file: File, existingPrompt: string, modelId?: string) {
    const formData = new FormData();
    formData.append('file', file);
    formData.append('existingPrompt', existingPrompt);
    if (modelId) formData.append('modelId', modelId);
    return api.post<any>('/analysis/modify-prompt', formData);
  },

  generateImage(prompt: string, aspectRatio: string, referenceFile?: File) {
    const formData = new FormData();
    formData.append('prompt', prompt);
    formData.append('aspectRatio', aspectRatio);
    if (referenceFile) formData.append('reference', referenceFile);
    return api.post<any>('/analysis/generate-image', formData);
  },

  extractVideo(url: string) {
    return api.post<Blob>('/proxy/video', { url });
  },

  extractImage(url: string) {
    return api.post<Blob>('/proxy/image', { url });
  },

  generateTts(text: string, voice: string, modelId?: string) {
    return api.post<{ audioBase64: string; mimeType: string }>('/analysis/generate-tts', { text, voice, modelId });
  },
};
