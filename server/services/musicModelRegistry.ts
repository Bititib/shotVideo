import { sqlite } from '../db/index.js';
import { PricingService } from './pricingService.js';
import { assertUserModelAccess } from './userModelAccessService.js';
import type { MinikeyModelDraft } from '../../shared/minikeyModelConfiguration.js';

/** Read-only registry, shared by discovery and execution. Never falls back to another channel. */
export function musicBinding(modelId: string, userId?: number | null) {
  const model = sqlite.prepare('SELECT * FROM models WHERE model_id=? AND is_active=1').get(modelId) as any;
  if (!model || model.provider!=='minikey' || !JSON.parse(model.capabilities).includes('music')) throw Object.assign(new Error('音乐模型未启用'),{status:404});
  assertUserModelAccess(userId,modelId);
  const bindings = (sqlite.prepare("SELECT * FROM settings WHERE key LIKE 'minikey_model_configurations_%'").all() as any[])
    .flatMap(s=>(JSON.parse(s.value) as MinikeyModelDraft[]).filter(d=>d.modelId===modelId && d.kind==='music' && d.enabled && d.routeEnabled)
      .map(d=>({draft:d,channelId:Number(s.key.slice('minikey_model_configurations_'.length))})));
  if (bindings.length!==1) throw Object.assign(new Error('音乐模型线路未启用或配置冲突'),{status:409});
  const binding=bindings[0];
  const c=sqlite.prepare("SELECT * FROM channels WHERE id=? AND type='minikey' AND status=1").get(binding.channelId) as any;
  if (!c?.api_key?.trim() || !JSON.parse(c.supported_models).includes(modelId) || JSON.parse(c.model_mapping)[modelId]!==binding.draft.upstreamModel) throw Object.assign(new Error('音乐模型渠道不可用'),{status:409});
  const quote=PricingService.quote(modelId,{count:1},false,userId);
  if (quote.billingType!=='per_call' || !Number.isFinite(quote.cost) || quote.cost<0) throw Object.assign(new Error('音乐模型需先设置按次售价'),{status:409});
  return {...binding,model,quote,channel:{id:c.id,type:c.type,baseUrl:c.base_url,apiKey:c.api_key,timeout:c.timeout}};
}
export function musicModelAvailable(modelId:string,userId?:number|null) { try {musicBinding(modelId,userId);return true;}catch{return false;} }
