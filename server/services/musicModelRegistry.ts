import { db, sqlite } from '../db/index.js';
import { models } from '../db/schema.js';
import { recordPublicModelReview } from './publicModelMetadataService.js';
import { PricingService } from './pricingService.js';
import { assertUserModelAccess } from './userModelAccessService.js';
import { validatePublicModelName } from './publicModelNameService.js';
import { getModelSpecifications } from './modelRoutingService.js';
import { getSunoBalance, getSunoModels, sunoBase, type SunoChannel } from './sunoMusicAdapter.js';
import { SUNO_CHANNEL_TYPE, SUNO_MUSIC_MODELS, type MusicOperation } from '../../shared/sunoMusic.js';

const fail=(message:string,status=409)=>Object.assign(new Error(message),{status});
const documented=(id:string)=>SUNO_MUSIC_MODELS.some(model=>model===id);

export function musicBinding(modelId:string,userId?:number|null) {
  if (!documented(modelId)) throw fail('音乐模型未启用',404);
  const model=sqlite.prepare('SELECT * FROM models WHERE model_id=? AND provider=? AND is_active=1').get(modelId,SUNO_CHANNEL_TYPE) as any;
  if (!model || !JSON.parse(model.capabilities).includes('music')) throw fail('音乐模型未启用',404);
  assertUserModelAccess(userId,modelId);
  const bindings=(sqlite.prepare('SELECT * FROM channels WHERE type=? AND status=1').all(SUNO_CHANNEL_TYPE) as any[])
    .filter(c=>JSON.parse(c.supported_models).includes(modelId) && JSON.parse(c.model_mapping)[modelId]===modelId && c.api_key?.trim());
  if (bindings.length!==1) throw fail('音乐模型需要唯一已启用的渠道绑定');
  const c=bindings[0];
  const channel:SunoChannel={id:c.id,baseUrl:sunoBase(c.base_url),apiKey:c.api_key.trim()};
  const quote=PricingService.quote(modelId,{count:1},false,userId);
  if (quote.billingType!=='per_call' || !Number.isFinite(quote.cost) || quote.cost<0) throw fail('音乐模型需先设置按次售价');
  return {channel,model,quote};
}
export function musicModelAvailable(modelId:string,userId?:number|null) { try {musicBinding(modelId,userId);return true;}catch{return false;} }
export function musicOperationQuote(binding:ReturnType<typeof musicBinding>,operation:MusicOperation,maxMode=false,userId?:number|null) {
  const quote=PricingService.musicOperationPrice(binding.model.model_id,operation,userId,maxMode);
  if(!quote)throw fail('管理员尚未配置此音乐操作的按次售价');
  return quote;
}
export function musicPrices(binding:ReturnType<typeof musicBinding>,userId?:number|null) {
  return PricingService.musicPrices(binding.model.model_id,userId);
}
export async function syncSunoMusicModels(channel:SunoChannel) {
  return applySunoCatalog(channel, await getSunoModels(channel));
}
function applySunoCatalog(channel:SunoChannel, listed:string[]) {
  const remote=listed.filter(documented);
  if (!remote.length) throw fail('上游型号目录未返回受支持的音乐模型',502);
  const supported:string[]=[],warnings:string[]=[];
  let added=0;
  sqlite.transaction(()=>{
    const c=sqlite.prepare('SELECT type,base_url,api_key FROM channels WHERE id=?').get(channel.id) as any;
    if (c?.type!==SUNO_CHANNEL_TYPE || c.api_key!==channel.apiKey || c.base_url!==channel.baseUrl) throw fail('渠道配置已变更，请重新同步');
    for(const id of [...new Set(remote)]) {
      const current=sqlite.prepare('SELECT id,provider,capabilities FROM models WHERE model_id=?').get(id) as any;
      const legacy=current?.provider==='minikey' && JSON.parse(current.capabilities).length===1 && JSON.parse(current.capabilities)[0]==='music';
      try {
        validatePublicModelName(id,id,current?.id);
        if (getModelSpecifications().some(s=>s.modelId===id||s.aliases.includes(id)) ||
          (current && current.provider!==SUNO_CHANNEL_TYPE && !legacy)) throw fail('已有其他模型占用名称');
      } catch { warnings.push(id+' 存在名称冲突，已跳过');continue; }
      if (!current) {
        db.insert(models).values({modelId:id,displayName:id,provider:SUNO_CHANNEL_TYPE,capabilities:'["music"]',isActive:0}).run();
        added++;
      } else if(legacy) {
        sqlite.prepare('UPDATE models SET provider=?,is_active=0 WHERE id=?').run(SUNO_CHANNEL_TYPE,current.id);
        warnings.push(id+' 的旧音乐条目已切换并停用，原价格及权限保留');
      }
      supported.push(id);
    }
    const mapping=Object.fromEntries(supported.map(id=>[id,id]));
    sqlite.prepare('UPDATE channels SET supported_models=?,model_mapping=?,max_retries=0 WHERE id=?')
      .run(JSON.stringify(supported),JSON.stringify(mapping),channel.id);
  }).immediate();
  return {count:supported.length,added,models:supported,warnings};
}

export async function configureSunoChannel(id:number, value:unknown) {
  const apiKey=typeof value==='string'?value.trim():'';
  if(!apiKey||apiKey.length>2048||/\s/.test(apiKey))throw fail('请填写有效的 Suno API Key',400);
  const readChannel=sqlite.prepare('SELECT type,base_url,api_key FROM channels WHERE id=?');
  const original=readChannel.get(id) as {type:string;base_url:string;api_key:string}|undefined;
  if(original?.type!==SUNO_CHANNEL_TYPE)throw fail('Suno 音乐渠道不存在',404);
  const channel={id,apiKey,baseUrl:sunoBase(original.base_url)};
  const [balance, listed]=await Promise.all([getSunoBalance(channel), getSunoModels(channel)]);
  if(!listed.some(documented))throw fail('该 Key 的模型列表未返回本站支持的音乐模型',502);
  return sqlite.transaction(()=>{
    const current=readChannel.get(id) as typeof original;
    if(current?.type!==SUNO_CHANNEL_TYPE||current.base_url!==original.base_url||current.api_key!==original.api_key) {
      throw fail('渠道配置已变更，请刷新后重试');
    }
    const message='鉴权成功，可用上游余额 ¥'+balance;
    sqlite.prepare(`UPDATE channels SET api_key=?,max_retries=0,
      status=CASE WHEN trim(api_key)='' THEN 1 ELSE status END,last_test_at=?,last_test_result=?,updated_at=datetime('now') WHERE id=?`)
      .run(apiKey,new Date().toISOString(),message,id);
    const result=applySunoCatalog(channel,listed);
    if(!result.count)throw fail('上游音乐模型与本站已有模型冲突，渠道配置未保存');
    const readModel=sqlite.prepare('SELECT id,is_active AS enabled FROM models WHERE provider=? AND model_id=?');
    const readPrice=sqlite.prepare("SELECT input_price FROM model_pricing WHERE model_pattern=? AND billing_type='per_call'");
    const enable=sqlite.prepare('UPDATE models SET is_active=1 WHERE id=?');
    const modelStatus=result.models.map(model=>{
      const row=readModel.get(SUNO_CHANNEL_TYPE,model) as {id:number;enabled:number};
      const price=readPrice.get(model) as {input_price:number}|undefined;
      const priced=typeof price?.input_price==='number'&&Number.isFinite(price.input_price)&&price.input_price>=0;
      if(!original.api_key.trim()&&priced&&!row.enabled) {
        enable.run(row.id);
        recordPublicModelReview(row.id,true);
        row.enabled=1;
      }
      return {model,enabled:row.enabled===1,priced};
    });
    return {...result,balance,message,modelStatus};
  }).immediate();
}
