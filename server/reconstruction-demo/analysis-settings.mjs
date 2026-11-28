// Read the selection from the existing website admin; never save another channel or key.
export function analysisSettings(store, catalog) {
  function snapshot() {
    const selected=catalog.selection();
    if(!selected) return {mode:'mock',model:'本地 Gemini 模拟响应',fixture:'rainy-letter-v1'};
    const route=catalog.resolve(selected.channelId,selected.modelId);
    if(!route) throw store.error('网站后台所选拉片渠道已不可用，请在现有渠道管理中重新选择',422);
    return {mode:'real',protocol:route.protocol,channelId:route.channelId,channelName:route.channelName,revision:route.revision,baseUrl:route.baseUrl,model:route.modelId,upstreamModel:route.upstreamModel};
  }
  return {
    get() { const input=snapshot(); return {selected:{mode:input.mode,channelId:input.channelId,model:input.model},notice:'拉片渠道与模型由网站现有后台「渠道管理」配置；已排除失效 aistudio2api。'}; },
    snapshot,
    credentials(input) {
      const route=catalog.resolve(input.channelId,input.model);
      if(!route || route.revision!==input.revision) throw store.error('提交前网站渠道配置已更改或失效，请重新确认',409);
      return route.apiKey;
    },
  };
}
