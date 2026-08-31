import { ChannelService } from './channelService.js';
import { isMjNewApiChannel } from './mjNewApiAdapter.js';
import {
  canUseMjOverflowModel,
  canUseWxHaidiYueOverflow,
  type HmStudioOverflowInput,
  MJ_OVERFLOW_VIDEO_MODEL,
} from './videoFailoverService.js';
import {
  isWxHaidiYueChannel,
  WX_HAIDIYUE_CHANNEL_TYPE,
  WX_HAIDIYUE_UPSTREAM_MODEL,
} from './wxHaidiYueAdapter.js';

export type HmStudioOverflowPlan = {
  channel: any;
  executionModel: string;
  kind: 'wx-haidiyue' | 'mjnewapi';
};

/** Prefer wx-海底月 sd2.5, then retain MJNewAPI as a secondary compatible fallback. */
export function findHmStudioOverflowPlan(
  input: HmStudioOverflowInput,
  excludedChannelIds: Iterable<number> = [],
): HmStudioOverflowPlan | null {
  const excluded = new Set(Array.from(excludedChannelIds, Number));
  if (canUseWxHaidiYueOverflow(input)) {
    const wxChannel = ChannelService.findChannelsByType(WX_HAIDIYUE_CHANNEL_TYPE)
      .find(channel => !excluded.has(channel.id));
    if (wxChannel && isWxHaidiYueChannel(wxChannel)) {
      return {
        channel: wxChannel,
        executionModel: WX_HAIDIYUE_UPSTREAM_MODEL,
        kind: 'wx-haidiyue',
      };
    }
  }

  if (canUseMjOverflowModel(input)) {
    const mjChannel = ChannelService.findChannelsForModel(MJ_OVERFLOW_VIDEO_MODEL)
      .find(channel => !excluded.has(channel.id));
    if (mjChannel && isMjNewApiChannel(mjChannel)) {
      return {
        channel: mjChannel,
        executionModel: MJ_OVERFLOW_VIDEO_MODEL,
        kind: 'mjnewapi',
      };
    }
  }

  return null;
}
