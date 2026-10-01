import type { TtsVoice } from '../../../shared/tts';
import { api } from './client';

export type AnalysisModel = { modelId: string; displayName: string };
export type StudioVoice = { voiceId: string; displayName: string; type: 'cloned' | 'prebuilt'; state: string; createdAt?: string };
export type TtsModel = { modelId: string; displayName: string; description?: string; rate?: number; voices?: string[]; voiceDetails?: TtsVoice[]; voiceSource?: 'upstream' | 'unavailable' };
export type ComicDramaCharacter = { name: string; role: string; description: string; assetPrompt: string };
export type ComicDramaProp = { name: string; description: string; assetPrompt: string };
export type ComicDramaShot = {
  shotNumber: number; duration: number; shotSize: string; camera: string; action: string;
  dialogue: string; characters: string[]; imagePrompt: string; videoPrompt: string;
  continuityStart?: string; continuityEnd?: string;
};
export type ComicDramaScene = {
  sceneNumber: number; title: string; location: string; time: string; summary: string;
  assetPrompt: string; shots: ComicDramaShot[];
};
export type ComicDramaBlueprint = {
  projectId?: number; episodeId?: number;
  title: string; logline: string; genre: string; visualStyle: string; estimatedDuration: number;
  characters: ComicDramaCharacter[]; props: ComicDramaProp[]; scenes: ComicDramaScene[];
};
export type ComicDramaEpisodeSummary = {
  id: number; projectId: number; episodeNumber: number; title: string; status: string;
  taskCount: number; doneCount: number; createdAt: string; updatedAt: string;
  analysisError?: string | null;
  progress: Record<'asset' | 'storyboard' | 'video', { total: number; done: number; running: number; failed: number; pending: number }>;
};
export type ComicDramaSeriesEpisodePlan = {
  episodeNumber: number; title: string; summary: string; hook: string; startBlock: number; endBlock: number;
  estimatedDuration: number; characterCount: number; script: string;
};
export type ComicDramaSeriesPlan = {
  title: string; logline: string; genre: string; visualStyle: string; totalCharacters: number;
  episodes: ComicDramaSeriesEpisodePlan[];
};
export type ComicDramaQualityReview = {
  score: number; consistencyPassed: boolean; summary: string; issues: string[]; correctedPrompt: string;
};
const MODEL_CACHE_TTL_MS = 30_000;
const PERSISTED_MODEL_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ANALYSIS_MODEL_CACHE_KEY = 'analysis-models-cache-v1';
const TTS_MODEL_CACHE_KEY = 'tts-models-cache-v2';
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
  getTtsModels(force = false) {
    const token = localStorage.getItem('token') || '';
    if (!force && ttsModelCache?.token === token && ttsModelCache.expiresAt > Date.now()) {
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

  analyzeComicDramaScript(script: string, modelId?: string) {
    return api.post<ComicDramaBlueprint>('/analysis/comic-drama-script', { script, modelId });
  },

  planComicDramaSeries(script: string, input: { targetDuration: number; requestedEpisodes?: number; modelId?: string }) {
    return api.post<ComicDramaSeriesPlan>('/analysis/comic-drama-series-plan', { script, ...input });
  },

  createComicDramaSeries(input: { title: string; originalScript: string; plan: ComicDramaSeriesPlan }) {
    return api.post<any>('/analysis/comic-drama-series', input);
  },

  listComicDramaProjects() {
    return api.get<Array<{ id: number; title: string; status: string; episodeCount: number; updatedAt: string; createdAt: string }>>('/analysis/comic-drama-projects');
  },

  getComicDramaProject(projectId: number) {
    return api.get<any>(`/analysis/comic-drama-projects/${projectId}`);
  },

  getComicDramaExportSummary(projectId: number, episodeId?: number) {
    const query = episodeId ? `?episodeId=${episodeId}` : '';
    return api.get<{ total: number; completed: number; unapproved: number; running: number; missing: number }>(`/analysis/comic-drama-projects/${projectId}/export-summary${query}`);
  },

  exportComicDramaVideos(projectId: number, input: { episodeId: number; scope: 'current' | 'all'; includeUnapproved: boolean }) {
    return api.post<{ url: string; count: number }>(`/analysis/comic-drama-projects/${projectId}/export-videos`, input);
  },

  createComicDramaEpisode(projectId: number, input: { title?: string; script?: string } = {}) {
    return api.post<any>(`/analysis/comic-drama-projects/${projectId}/episodes`, input);
  },

  getComicDramaEpisode(projectId: number, episodeId: number) {
    return api.get<any>(`/analysis/comic-drama-projects/${projectId}/episodes/${episodeId}`);
  },

  saveComicDramaEpisodeDraft(projectId: number, episodeId: number, input: { title?: string; script?: string }) {
    return api.put<{ id: number; title: string; status: string; updatedAt: string }>(`/analysis/comic-drama-projects/${projectId}/episodes/${episodeId}`, input);
  },

  analyzeComicDramaEpisode(projectId: number, episodeId: number, script: string, modelId?: string) {
    return api.post<ComicDramaBlueprint>(`/analysis/comic-drama-projects/${projectId}/episodes/${episodeId}/analyze`, { script, modelId });
  },

  analyzeComicDramaEpisodes(projectId: number, input: { episodeIds?: number[]; modelId?: string } = {}) {
    return api.post<{ projectId: number; queued: number; episodeIds: number[] }>(`/analysis/comic-drama-projects/${projectId}/analyze-episodes`, input);
  },

  saveComicDramaEpisodeState(projectId: number, episodeId: number, state: any, status = 'producing') {
    return api.put<{ id: number; projectId: number; status: string; updatedAt: string }>(`/analysis/comic-drama-projects/${projectId}/episodes/${episodeId}/state`, { state, status });
  },

  saveComicDramaProjectState(projectId: number, state: any, status?: string) {
    return api.put<{ id: number; status: string; updatedAt: string }>(`/analysis/comic-drama-projects/${projectId}/state`, { state, status });
  },

  startComicDramaManaged(projectId: number, episodeId: number, state: any, scope: 'current' | 'all' = 'current') {
    return api.post<{ id: number; status: string }>(`/analysis/comic-drama-projects/${projectId}/managed`, { episodeId, state, scope });
  },

  stopComicDramaManaged(projectId: number) {
    return api.post<{ id: number; status: string }>(`/analysis/comic-drama-projects/${projectId}/managed/stop`);
  },

  reviewComicDramaImage(input: { imageUrl: string; kind: string; name: string; expectedPrompt: string; visualStyle: string; modelId?: string }) {
    return api.post<ComicDramaQualityReview>('/analysis/comic-drama-quality-review', input);
  },

  reviewComicDramaVideo(input: { videoUrl: string; name: string; expectedPrompt: string; continuityStart?: string; continuityEnd?: string; visualStyle: string; modelId?: string }) {
    return api.post<ComicDramaQualityReview>('/analysis/comic-drama-video-quality-review', input);
  },

  uploadComicDramaAsset(file: File) {
    const formData = new FormData(); formData.append('file', file);
    return api.post<{ url: string }>('/analysis/comic-drama-assets/upload', formData);
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
    return api.post<{ audioBase64: string; mimeType: string; usedVoice?: string; warning?: string }>('/analysis/generate-tts', { text, voice, modelId });
  },
  getClonedVoices() { return api.get<StudioVoice[]>('/analysis/cloned-voices'); },
  cloneVoice(audio: File, displayName: string) {
    const body = new FormData(); body.append('audio', audio); body.append('displayName', displayName);
    return api.post<{ voiceId: string; displayName: string; state: string }>('/analysis/cloned-voices', body);
  },
  deleteClonedVoice(voiceId: string) { return api.delete('/analysis/cloned-voices', { body: JSON.stringify({ voiceId }) }); },
};
