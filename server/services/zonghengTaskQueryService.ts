import { ChannelService } from './channelService.js';
import { zonghengTaskUrl } from './zonghengAdapter.js';
/** Refresh configuration on the original channel; never route an existing task elsewhere. */
export function queryZonghengTask(taskId: string, channelId: number | undefined, keyId: number | null | undefined, fallback: {baseUrl:string;apiKey:string}) {
  const channel = channelId ? ChannelService.getChannelRaw(channelId, keyId || null) : fallback;
  if (!channel?.baseUrl || !channel.apiKey) throw new Error('原任务查询配置不可用，请核查原渠道');
  return fetch(zonghengTaskUrl(channel.baseUrl,taskId), {headers:{Authorization:'Bearer '+channel.apiKey,'Cache-Control':'no-cache, no-store',Pragma:'no-cache'},
    cache:'no-store',signal:AbortSignal.timeout(15_000),redirect:'error'});
}
