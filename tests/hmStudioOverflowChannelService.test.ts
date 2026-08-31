import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelService } from '../server/services/channelService.js';
import {
  findHmStudioOverflowPlan,
  hasHmStudioOverflowChannel,
} from '../server/services/hmStudioOverflowChannelService.js';

const compatibleRequest = {
  requestedModel: 'seedance_v2.5',
  resolution: '720p',
  seconds: 30,
  imageCount: 0,
  videoCount: 0,
  audioCount: 0,
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('HM Studio overflow channel selection', () => {
  it('keeps HM Studio requests routable through wx when HM is manually stopped', () => {
    vi.spyOn(ChannelService, 'findChannelsByType').mockReturnValue([
      { id: 31, type: 'wx-haidiyue' },
    ] as any);
    vi.spyOn(ChannelService, 'findChannelsForModel').mockReturnValue([] as any);

    expect(hasHmStudioOverflowChannel()).toBe(true);
    expect(findHmStudioOverflowPlan(compatibleRequest)).toMatchObject({
      channel: { id: 31 },
      executionModel: 'sd2.5',
      kind: 'wx-haidiyue',
    });
  });

  it('uses MJ when wx is stopped and the request remains compatible', () => {
    vi.spyOn(ChannelService, 'findChannelsByType').mockReturnValue([] as any);
    vi.spyOn(ChannelService, 'findChannelsForModel').mockReturnValue([
      { id: 32, type: 'mjnewapi', baseUrl: 'https://mjnewapi.diwdiw.cn' },
    ] as any);

    expect(findHmStudioOverflowPlan(compatibleRequest)).toMatchObject({
      channel: { id: 32 },
      executionModel: 'xd-seedance-2.5-720p',
      kind: 'mjnewapi',
    });
  });

  it('does not route requests above every fallback image limit after HM is stopped', () => {
    vi.spyOn(ChannelService, 'findChannelsByType').mockReturnValue([
      { id: 31, type: 'wx-haidiyue' },
    ] as any);
    vi.spyOn(ChannelService, 'findChannelsForModel').mockReturnValue([
      { id: 32, type: 'mjnewapi', baseUrl: 'https://mjnewapi.diwdiw.cn' },
    ] as any);

    expect(findHmStudioOverflowPlan({ ...compatibleRequest, imageCount: 11 })).toBeNull();
  });

  it('never sends 四月天 sd2.5 requests to HM fallback channels', () => {
    vi.spyOn(ChannelService, 'findChannelsByType').mockReturnValue([
      { id: 31, type: 'wx-haidiyue' },
    ] as any);
    vi.spyOn(ChannelService, 'findChannelsForModel').mockReturnValue([
      { id: 32, type: 'mjnewapi', baseUrl: 'https://mjnewapi.diwdiw.cn' },
    ] as any);

    expect(findHmStudioOverflowPlan({
      ...compatibleRequest,
      requestedModel: 'sd2.5',
    })).toBeNull();
  });

});
