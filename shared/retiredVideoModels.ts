import { channelVideoProtocols } from './channelModelConfiguration.js';
import type { ModelRoute } from './modelRouting.js';

/** Legacy routes stay blocked; only explicitly reconfigured snumom routes may return. */
export const RETIRED_VIDEO_MODELS = ['wan3.0-video', 'wan3.0-video-prime'] as const;
export const RETIRED_VIDEO_MODEL_MESSAGE = '该视频模型已下架，不再接受新生成请求，本次未扣费';
export function isRetiredVideoModel(model: unknown): boolean {
  return typeof model === 'string' && (RETIRED_VIDEO_MODELS as readonly string[]).includes(model);
}

export const SNUMOM_RECONNECT_CHANNEL_ID = 14;
export function isSnumomReconnectChannel(channel: { id: number; type?: string }) {
  return channel.id === SNUMOM_RECONNECT_CHANNEL_ID && channel.type === 'snumom';
}

export function isReconnectedSnumomRoute(model: string, route: ModelRoute) {
  return isRetiredVideoModel(model) && route.channelId === SNUMOM_RECONNECT_CHANNEL_ID
    && route.id.startsWith(channelVideoProtocols.snumom.prefix)
    && route.executionModel === model && route.upstreamModel === model
    && route.snumom?.billingType === 'per_second' && route.snumom.referenceVideoBilling === true;
}
