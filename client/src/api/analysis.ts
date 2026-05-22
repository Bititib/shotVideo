import { api } from './client';

export const analysisApi = {
  /** 获取当前用户可用的模型列表 */
  getAvailableModels() {
    return api.get<{ modelId: string; displayName: string }[]>('/analysis/models');
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
};
