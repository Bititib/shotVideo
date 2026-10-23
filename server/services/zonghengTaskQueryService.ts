import { fetchVideoTaskResponse } from './videoPollDeadline.js';
import { ChannelService } from './channelService.js';
import { zonghengTaskUrl } from './zonghengAdapter.js';
import { zonghengProtocol, zonghengTaskChannel } from './zonghengProtocol.js';
/** Refresh configuration on the original channel; never route an existing task elsewhere. */
export function queryZonghengTask(taskId: string, channelId: number | undefined, keyId: number | null | undefined, fallback: {baseUrl:string;apiKey:string;type?:string}, metadata: Record<string, any> = {}) {
  const original = channelId ? ChannelService.getChannelRaw(channelId, keyId || null) : fallback;
  const channel = original ? zonghengTaskChannel(original, metadata) : null;
  if (!channel?.baseUrl || !channel.apiKey) throw new Error('原任务查询配置不可用，请核查原渠道');
  return fetchVideoTaskResponse(zonghengTaskUrl(channel.baseUrl,taskId,zonghengProtocol(channel,metadata)), {headers:{Authorization:'Bearer '+channel.apiKey,'Cache-Control':'no-cache, no-store',Pragma:'no-cache'},
    cache:'no-store',redirect:'error'});
}
