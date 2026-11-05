import { api } from './client';
import type { DeveloperModelCatalog } from '../../../shared/developerModels';

export const developerApi = {
  getPublicModels(signal?: AbortSignal) {
    return api.get<DeveloperModelCatalog>('/developer/models/public', { signal, skipAuth: true });
  },
  getStandardModels(signal?: AbortSignal) {
    return api.get<DeveloperModelCatalog>('/developer/models/standard', { signal });
  },
  getModels(tokenId: number, signal?: AbortSignal) {
    return api.get<DeveloperModelCatalog>(`/developer/models?tokenId=${tokenId}`, { signal });
  },
};
