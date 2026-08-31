import { ChannelService } from './channelService.js';
import { db } from '../db/index.js';
import { settings } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import {
  buildJulunSd25Payload,
  isJulunChannel,
  JULUN_SD25_MODEL,
} from './julunMinimaxAdapter.js';
import {
  canUseSiYueTianJulunOverflow,
  type HmStudioOverflowInput,
} from './videoFailoverService.js';

export const SI_YUE_TIAN_VIDEO_MODEL = 'sd2.5';
export const SI_YUE_TIAN_HOSTNAME = 'llm.chre3.com';
export const SI_YUE_TIAN_ROUTING_STRATEGY_KEY = 'siyuetian_sd25_routing_strategy';
export const SI_YUE_TIAN_ROUND_ROBIN_NEXT_KEY = 'internal_siyuetian_sd25_round_robin_next';
export type SiYueTianRoutingStrategy = 'failover' | 'round_robin';

export type SiYueTianChannelLike = {
  baseUrl?: string | null;
};

export function isSiYueTianChannel(channel: SiYueTianChannelLike | null | undefined): boolean {
  if (!channel?.baseUrl) return false;
  try {
    return new URL(channel.baseUrl).hostname.toLowerCase() === SI_YUE_TIAN_HOSTNAME;
  } catch {
    return false;
  }
}

export type SiYueTianOverflowPlan = {
  channel: any;
  executionModel: typeof JULUN_SD25_MODEL;
  kind: 'julun';
};

export type SiYueTianRouteSelection = {
  channel: any;
  executionModel: typeof JULUN_SD25_MODEL;
  kind: 'siyuetian' | 'julun';
  reason: '' | 'siyuetian_disabled' | 'siyuetian_round_robin';
};

export function getSiYueTianRoutingStrategy(): SiYueTianRoutingStrategy {
  const value = db.select().from(settings).where(eq(settings.key, SI_YUE_TIAN_ROUTING_STRATEGY_KEY)).get()?.value;
  return value === 'round_robin' ? 'round_robin' : 'failover';
}

function advanceRoundRobin(selected: 'siyuetian' | 'julun'): void {
  db.update(settings).set({
    value: selected === 'siyuetian' ? 'julun' : 'siyuetian',
    updatedAt: new Date().toISOString(),
  }).where(eq(settings.key, SI_YUE_TIAN_ROUND_ROBIN_NEXT_KEY)).run();
}

/** Strictly alternate between 四月天 and Julun while both are enabled and compatible. */
export function selectSiYueTianRoute(input: HmStudioOverflowInput): SiYueTianRouteSelection | null {
  const primary = ChannelService.findChannelsForModel(SI_YUE_TIAN_VIDEO_MODEL).find(isSiYueTianChannel) || null;
  const julun = findSiYueTianOverflowPlan(input);
  const strategy = getSiYueTianRoutingStrategy();

  if (strategy === 'round_robin' && primary && julun) {
    const next = db.select().from(settings).where(eq(settings.key, SI_YUE_TIAN_ROUND_ROBIN_NEXT_KEY)).get()?.value;
    const selected = next === 'julun' ? 'julun' : 'siyuetian';
    advanceRoundRobin(selected);
    return selected === 'julun'
      ? { channel: julun.channel, executionModel: julun.executionModel, kind: 'julun', reason: 'siyuetian_round_robin' }
      : { channel: primary, executionModel: SI_YUE_TIAN_VIDEO_MODEL, kind: 'siyuetian', reason: '' };
  }

  if (primary) return { channel: primary, executionModel: SI_YUE_TIAN_VIDEO_MODEL, kind: 'siyuetian', reason: '' };
  if (julun) return { channel: julun.channel, executionModel: julun.executionModel, kind: 'julun', reason: 'siyuetian_disabled' };
  return null;
}

export function findSiYueTianOverflowPlan(
  input: HmStudioOverflowInput,
  excludedChannelIds: Iterable<number> = [],
): SiYueTianOverflowPlan | null {
  if (!canUseSiYueTianJulunOverflow(input)) return null;
  const excluded = new Set(Array.from(excludedChannelIds, Number));
  const channel = ChannelService.findChannelsForModel(JULUN_SD25_MODEL)
    .find(candidate => isJulunChannel(candidate) && !excluded.has(candidate.id));
  return channel ? { channel, executionModel: JULUN_SD25_MODEL, kind: 'julun' } : null;
}

export async function submitSiYueTianOverflowPlan(
  plan: SiYueTianOverflowPlan,
  input: { prompt: string; ratio: string; imageUrls: string[] },
): Promise<Response> {
  return fetch(`${plan.channel.baseUrl.replace(/\/+$/, '')}/v1/videos`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${plan.channel.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(buildJulunSd25Payload(input)),
    signal: AbortSignal.timeout(plan.channel.timeout || 120_000),
  });
}
