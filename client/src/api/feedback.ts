import { api } from './client';

export interface CreateModelFeedbackInput {
  contentId?: number | null;
  modelId: string;
  errorMessage: string;
  description?: string;
}

export const feedbackApi = {
  create(data: CreateModelFeedbackInput) {
    return api.post<{ id: number; duplicate: boolean; message: string }>('/feedback', data);
  },
};
