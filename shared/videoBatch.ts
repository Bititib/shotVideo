export type BatchItemStatus = 'queued' | 'dispatching' | 'running' | 'retry_wait' | 'completed' | 'failed' | 'cancelled' | 'review';
export interface VideoBatchInput {
  name: string;
  model: string;
  aspect_ratio: string;
  video_length: number;
  resolution: string;
  autoRetry: boolean;
  maxRetries: number;
  creatives: { prompt: string; count: number; reference_images: string[]; reference_videos?: string[]; audio_urls?: string[] }[];
}
export interface VideoBatchItem {
  id: number; creative_index: number; ordinal: number; status: BatchItemStatus;
  attempts: number; retry_count: number; unit_cost: number; charged: number;
  content_id: number | null; result_url: string | null; error: string | null;
  created_at: string; started_at: string | null; finished_at: string | null;
  billing_state: 'reserved' | 'charged' | 'refunded';
}
export interface VideoBatchDetail {
  id: number; name: string; model: string; total: number; auto_retry: number;
  max_retries: number; created_at: string; reserved: number; spent: number; refunded: number;
  items: VideoBatchItem[];
}
