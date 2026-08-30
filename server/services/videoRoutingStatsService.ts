import { db } from '../db/index.js';
import { contents } from '../db/schema.js';
import { eq } from 'drizzle-orm';

export type VideoRoutingStatsPeriod = 'all' | '24h' | '7d' | '30d';

export type VideoRoutingStatsRecord = {
  status: string;
  modelId?: string | null;
  metadata?: string | Record<string, any> | null;
  createdAt?: string | null;
};

export type VideoRoutingChannelStats = {
  channelType: 'wx-haidiyue' | 'mjnewapi';
  channelName: string;
  modelId: string;
  running: number;
  succeeded: number;
  failed: number;
  total: number;
  successRate: number;
  averageDurationMs: number;
  capacityOverflowCount: number;
  upstreamConcurrencyCount: number;
};

const ROUTING_CHANNELS: Array<Pick<VideoRoutingChannelStats, 'channelType' | 'channelName' | 'modelId'>> = [
  { channelType: 'wx-haidiyue', channelName: 'wx-海底月', modelId: 'sd2.5' },
  { channelType: 'mjnewapi', channelName: 'MJ 2.5', modelId: 'xd-seedance-2.5-720p' },
];

function parseMetadata(value: VideoRoutingStatsRecord['metadata']): Record<string, any> {
  try {
    return typeof value === 'string' ? JSON.parse(value || '{}') : { ...(value || {}) };
  } catch {
    return {};
  }
}

function createdAtTime(value: string | null | undefined): number {
  if (!value) return 0;
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    ? `${value.replace(' ', 'T')}Z`
    : value;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function periodStart(period: VideoRoutingStatsPeriod, now: number): number {
  if (period === '24h') return now - 24 * 60 * 60 * 1000;
  if (period === '7d') return now - 7 * 24 * 60 * 60 * 1000;
  if (period === '30d') return now - 30 * 24 * 60 * 60 * 1000;
  return 0;
}

export function aggregateVideoRoutingStats(
  records: VideoRoutingStatsRecord[],
  period: VideoRoutingStatsPeriod = 'all',
  now = Date.now(),
): VideoRoutingChannelStats[] {
  const start = periodStart(period, now);

  return ROUTING_CHANNELS.map(definition => {
    let running = 0;
    let succeeded = 0;
    let failed = 0;
    let durationTotal = 0;
    let durationCount = 0;
    let capacityOverflowCount = 0;
    let upstreamConcurrencyCount = 0;

    for (const record of records) {
      const metadata = parseMetadata(record.metadata);
      if (metadata.actualChannel !== definition.channelType) continue;

      const status = String(record.status || '').toLowerCase();
      if (status === 'processing' || status === 'queued') running++;

      const inPeriod = period === 'all' || createdAtTime(record.createdAt) >= start;
      if (!inPeriod) continue;

      if (status === 'completed' || status === 'success') {
        succeeded++;
        const duration = Number(metadata.durationMs);
        if (Number.isFinite(duration) && duration > 0) {
          durationTotal += duration;
          durationCount++;
        }
      } else if (status === 'failed' || status === 'error') {
        failed++;
      }

      if (metadata.fallbackReason === 'hmstudio_capacity') capacityOverflowCount++;
      if (metadata.fallbackReason === 'hmstudio_upstream_concurrency') upstreamConcurrencyCount++;
    }

    const finished = succeeded + failed;
    return {
      ...definition,
      running,
      succeeded,
      failed,
      total: running + finished,
      successRate: finished > 0 ? Math.round((succeeded / finished) * 1000) / 10 : 0,
      averageDurationMs: durationCount > 0 ? Math.round(durationTotal / durationCount) : 0,
      capacityOverflowCount,
      upstreamConcurrencyCount,
    };
  });
}

export class VideoRoutingStatsService {
  static getStats(period: VideoRoutingStatsPeriod = 'all') {
    const records = db.select({
      status: contents.status,
      modelId: contents.modelId,
      metadata: contents.metadata,
      createdAt: contents.createdAt,
    }).from(contents).where(eq(contents.type, 'video')).all();

    return {
      period,
      generatedAt: new Date().toISOString(),
      channels: aggregateVideoRoutingStats(records, period),
    };
  }
}
