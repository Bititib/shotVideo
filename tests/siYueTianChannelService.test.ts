import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelService } from '../server/services/channelService.js';
import { db } from '../server/db/index.js';
import { settings } from '../server/db/schema.js';
import { eq } from 'drizzle-orm';
import {
  findSiYueTianOverflowPlan,
  isSiYueTianChannel,
  selectSiYueTianRoute,
  SI_YUE_TIAN_ROUND_ROBIN_NEXT_KEY,
  SI_YUE_TIAN_ROUTING_STRATEGY_KEY,
  submitSiYueTianOverflowPlan,
} from '../server/services/siYueTianChannelService.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('四月天 channel detection', () => {
  it('recognizes only the configured llm.chre3.com origin', () => {
    expect(isSiYueTianChannel({ baseUrl: 'https://llm.chre3.com' })).toBe(true);
    expect(isSiYueTianChannel({ baseUrl: 'https://llm.chre3.com/v1/' })).toBe(true);
    expect(isSiYueTianChannel({ baseUrl: 'https://example.com' })).toBe(false);
    expect(isSiYueTianChannel(null)).toBe(false);
  });

  it('selects only the Julun sd2.5 channel as the fallback', () => {
    vi.spyOn(ChannelService, 'findChannelsForModel').mockReturnValue([
      { id: 20, baseUrl: 'https://ap.968968968.xyz/v1', type: 'wx-haidiyue' },
      { id: 21, baseUrl: 'https://julun.cc', type: 'openai' },
    ] as any);

    expect(findSiYueTianOverflowPlan({
      requestedModel: 'sd2.5',
      resolution: '720p',
      seconds: 30,
      imageCount: 9,
      videoCount: 0,
      audioCount: 0,
    })).toMatchObject({
      channel: { id: 21 },
      executionModel: 'sd2.5',
      kind: 'julun',
    });
  });

  it('submits the fallback request to Julun /v1/videos', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'julun-1' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const response = await submitSiYueTianOverflowPlan({
      channel: {
        id: 21,
        baseUrl: 'https://julun.cc',
        apiKey: 'julun-key',
        timeout: 120000,
      },
      executionModel: 'sd2.5',
      kind: 'julun',
    }, {
      prompt: 'test prompt',
      ratio: '9:16',
      imageUrls: ['https://assets.example/ref.jpg'],
    });

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('https://julun.cc/v1/videos', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer julun-key' }),
    }));
    const request = fetchMock.mock.calls[0][1];
    expect(JSON.parse(String(request.body))).toMatchObject({
      model: 'sd2.5',
      seconds: 30,
      ratio: '9:16',
      resolution: '720p',
      image_urls: ['https://assets.example/ref.jpg'],
    });
  });

  it('strictly alternates one request per channel in round-robin mode', () => {
    const strategyRow = db.select().from(settings).where(eq(settings.key, SI_YUE_TIAN_ROUTING_STRATEGY_KEY)).get();
    const cursorRow = db.select().from(settings).where(eq(settings.key, SI_YUE_TIAN_ROUND_ROBIN_NEXT_KEY)).get();
    if (!strategyRow) db.insert(settings).values({ key: SI_YUE_TIAN_ROUTING_STRATEGY_KEY, value: 'round_robin', label: 'test' }).run();
    if (!cursorRow) db.insert(settings).values({ key: SI_YUE_TIAN_ROUND_ROBIN_NEXT_KEY, value: 'siyuetian', label: 'test' }).run();
    db.update(settings).set({ value: 'round_robin' }).where(eq(settings.key, SI_YUE_TIAN_ROUTING_STRATEGY_KEY)).run();
    db.update(settings).set({ value: 'siyuetian' }).where(eq(settings.key, SI_YUE_TIAN_ROUND_ROBIN_NEXT_KEY)).run();
    vi.spyOn(ChannelService, 'findChannelsForModel').mockReturnValue([
      { id: 20, baseUrl: 'https://llm.chre3.com', type: 'openai' },
      { id: 21, baseUrl: 'https://julun.cc', type: 'openai' },
    ] as any);
    const input = {
      requestedModel: 'sd2.5', resolution: '720p', seconds: 30,
      imageCount: 0, videoCount: 0, audioCount: 0,
    };

    try {
      expect([1, 2, 3, 4].map(() => selectSiYueTianRoute(input)?.kind))
        .toEqual(['siyuetian', 'julun', 'siyuetian', 'julun']);
      vi.mocked(ChannelService.findChannelsForModel).mockReturnValue([
        { id: 20, baseUrl: 'https://llm.chre3.com', type: 'openai' },
      ] as any);
      expect([selectSiYueTianRoute(input)?.kind, selectSiYueTianRoute(input)?.kind])
        .toEqual(['siyuetian', 'siyuetian']);
      vi.mocked(ChannelService.findChannelsForModel).mockReturnValue([
        { id: 21, baseUrl: 'https://julun.cc', type: 'openai' },
      ] as any);
      expect([selectSiYueTianRoute(input)?.kind, selectSiYueTianRoute(input)?.kind])
        .toEqual(['julun', 'julun']);
    } finally {
      if (strategyRow) db.update(settings).set({ value: strategyRow.value }).where(eq(settings.key, SI_YUE_TIAN_ROUTING_STRATEGY_KEY)).run();
      else db.delete(settings).where(eq(settings.key, SI_YUE_TIAN_ROUTING_STRATEGY_KEY)).run();
      if (cursorRow) db.update(settings).set({ value: cursorRow.value }).where(eq(settings.key, SI_YUE_TIAN_ROUND_ROBIN_NEXT_KEY)).run();
      else db.delete(settings).where(eq(settings.key, SI_YUE_TIAN_ROUND_ROBIN_NEXT_KEY)).run();
    }
  });
});
