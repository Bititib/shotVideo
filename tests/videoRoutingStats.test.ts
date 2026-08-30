import { describe, expect, it } from 'vitest';
import { aggregateVideoRoutingStats } from '../server/services/videoRoutingStatsService.js';

const NOW = Date.parse('2026-08-30T12:00:00.000Z');

describe('video routing channel statistics', () => {
  const records = [
    {
      status: 'processing',
      modelId: 'seedance_v2.5',
      createdAt: '2026-08-30T11:50:00.000Z',
      metadata: JSON.stringify({
        actualChannel: 'wx-haidiyue',
        actualModel: 'sd2.5',
        fallbackReason: 'hmstudio_capacity',
      }),
    },
    {
      status: 'completed',
      modelId: 'seedance_v2.5',
      createdAt: '2026-08-30T10:00:00.000Z',
      metadata: JSON.stringify({
        actualChannel: 'wx-haidiyue',
        actualModel: 'sd2.5',
        fallbackReason: 'hmstudio_upstream_concurrency',
        durationMs: 90_000,
      }),
    },
    {
      status: 'failed',
      modelId: 'seedance_v2.5',
      createdAt: '2026-08-29T18:00:00.000Z',
      metadata: JSON.stringify({
        actualChannel: 'wx-haidiyue',
        actualModel: 'sd2.5',
        fallbackReason: 'hmstudio_capacity',
      }),
    },
    {
      status: 'completed',
      modelId: 'seedance_v2.5',
      createdAt: '2026-08-20T10:00:00.000Z',
      metadata: JSON.stringify({
        actualChannel: 'mjnewapi',
        actualModel: 'xd-seedance-2.5-720p',
        fallbackReason: 'hmstudio_capacity',
        durationMs: 120_000,
      }),
    },
    {
      status: 'completed',
      modelId: 'seedance_v2.5',
      createdAt: '2026-08-30T11:00:00.000Z',
      metadata: JSON.stringify({ actualChannel: 'hmstudio', durationMs: 60_000 }),
    },
  ];

  it('separates wx-海底月 and MJ success, failure, running, reasons, and duration', () => {
    const [wx, mj] = aggregateVideoRoutingStats(records, 'all', NOW);
    expect(wx).toMatchObject({
      channelType: 'wx-haidiyue',
      modelId: 'sd2.5',
      running: 1,
      succeeded: 1,
      failed: 1,
      total: 3,
      successRate: 50,
      averageDurationMs: 90_000,
      capacityOverflowCount: 2,
      upstreamConcurrencyCount: 1,
    });
    expect(mj).toMatchObject({
      channelType: 'mjnewapi',
      running: 0,
      succeeded: 1,
      failed: 0,
      successRate: 100,
      averageDurationMs: 120_000,
    });
  });

  it('filters finished totals by period while keeping current running concurrency visible', () => {
    const [wx, mj] = aggregateVideoRoutingStats(records, '24h', NOW);
    expect(wx).toMatchObject({ running: 1, succeeded: 1, failed: 1, total: 3 });
    expect(mj).toMatchObject({ running: 0, succeeded: 0, failed: 0, total: 0 });
  });
});
