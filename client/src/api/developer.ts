import { api } from './client';
import type { DeveloperModelCatalog } from '../../../shared/developerModels';

export const developerApi = {
  getModels(tokenId: number, signal?: AbortSignal) {
    return api.get<DeveloperModelCatalog>(`/developer/models?tokenId=${tokenId}`, { signal });
  },
};
