import { api } from './client';

export type AnalysisModel = { modelId: string; displayName: string };
export type TtsModel = { modelId: string; displayName: string; rate?: number };
const MODEL_CACHE_TTL_MS = 30_000;
const PERSISTED_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ANALYSIS_MODEL_CACHE_KEY = 'analysis-models-cache-v1';
const TTS_MODEL_CACHE_KEY = 'tts-models-cache-v1';
let analysisModelCache: { token: string; expiresAt: number; data: AnalysisModel[] } | null = null;
let analysisModelRequest: { token: string; promise: Promise<AnalysisModel[]> } | null = null;
let ttsModelCache: { token: string; expiresAt: number; data: TtsModel[] } | null = null;
let ttsModelRequest: { token: string; promise: Promise<TtsModel[]> } | null = null;

function readPersistedModels<T>(key: string, isValid: (model: any) => boolean): T[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const token = localStorage.getItem('token') || '';
    const cached = JSON.parse(localStorage.getItem(key) || 'null');
    if (!cached || cached.token !== token || !Array.isArray(cached.data)
      || Date.now() - Number(cached.savedAt || 0) > PERSISTED_MODEL_CACHE_TTL_MS) return [];
    return cached.data.filter(isValid);
  } catch {
    return [];
  }
}

function persistModels<T>(key: string, token: string, data: T[]) {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify({ token, savedAt: Date.now(), data }));
  } catch { /* storage may be disabled or full */ }
}

export function getCachedAnalysisModels(): AnalysisModel[] {
  return readPersistedModels<AnalysisModel>(
    ANALYSIS_MODEL_CACHE_KEY,
    model => model && typeof model.modelId === 'string' && typeof model.displayName === 'string',
  );
}

export function getCachedTtsModels(): TtsModel[] {
  return readPersistedModels<TtsModel>(
    TTS_MODEL_CACHE_KEY,
    model => model && typeof model.modelId === 'string' && typeof model.displayName === 'string',
  );
}

export const analysisApi = {
  /** 获取当前用户可用的模型列表 */
  getAvailableModels() {
    const token = localStorage.getItem('token') || '';
    if (analysisModelCache?.token === token && analysisModelCache.expiresAt > Date.now()) {
      return Promise.resolve(analysisModelCache.data);
    }
    if (analysisModelRequest?.token === token) return analysisModelRequest.promise;
    const promise = api.get<AnalysisModel[]>('/analysis/models')
      .then((data) => {
        analysisModelCache = { token, expiresAt: Date.now() + MODEL_CACHE_TTL_MS, data };
        persistModels(ANALYSIS_MODEL_CACHE_KEY, token, data);
        return data;
      })
      .finally(() => {
        if (analysisModelRequest?.promise === promise) analysisModelRequest = null;
      });
    analysisModelRequest = { token, promise };
    return promise;
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
        ttsModelCache = { token, expiresAt: Date.now() + MODEL_CACHE_TTL_MS, data };
        persistModels(TTS_MODEL_CACHE_KEY, token, data);
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
