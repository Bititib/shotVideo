import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sqlite } from '../db/index.js';
import { musicBinding } from './musicModelRegistry.js';
import { buildMinikeyMusic, submitMinikey, pollMinikey, normalizeMinikeyTask, fetchMinikeyFile, MinikeyError, type MinikeyChannel } from './minikeyAdapter.js';
import { ensureBillingReservations, reserveUserCharge, linkReservationContent } from './billingReservation.js';
import { BalanceService } from './balanceService.js';
import { TokenService } from './tokenService.js';
import { captureFundEntries, withFundContext } from '../db/fundLedger.js';
import { registerUpload } from './uploadAccess.js';
import type { PricingSnapshot } from './pricingService.js';
import { transportDiagnostic } from './upstreamDiagnostic.js';
import { publicGenerationError } from '../../shared/generationMessages.js';

export type MusicOwner = { userId?:number|null; tokenId?:number; allowedModels?:string[];
  reserve?:(cost:number,model:string,snapshot?:PricingSnapshot)=>{id:string} };
const fail=(message:string,status=400)=>Object.assign(new Error(message),{status});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fingerprint=(c:MinikeyChannel)=>hash([c.baseUrl,c.apiKey]);
export function ensureMusicJobs() {
  ensureBillingReservations();
  sqlite.exec(`CREATE TABLE IF NOT EXISTS music_jobs (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    content_id INTEGER NOT NULL UNIQUE, channel_id INTEGER NOT NULL, credential_hash TEXT NOT NULL,
    payload TEXT NOT NULL, upstream_id TEXT, state TEXT NOT NULL, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    next_poll INTEGER NOT NULL DEFAULT 0, error TEXT, UNIQUE(owner,request_key));`);
  if (!(sqlite.prepare('PRAGMA table_info(music_jobs)').all() as any[]).some(c=>c.name==='receipt')) sqlite.exec('ALTER TABLE music_jobs ADD COLUMN receipt TEXT');
}
function ownerKey(owner:MusicOwner) {
  if (owner.tokenId) return 'token:'+owner.tokenId;
  if (owner.userId) return 'user:'+owner.userId;
  throw fail('请先登录',401);
}
function job(id:string) { return sqlite.prepare('SELECT * FROM music_jobs WHERE id=?').get(id) as any; }
export function getMusicTask(id:string,owner:MusicOwner) {
  ensureMusicJobs(); const row=job(id);
  if (!row || row.owner!==ownerKey(owner)) throw fail('音乐任务不存在',404);
  const c=sqlite.prepare('SELECT * FROM contents WHERE id=?').get(row.content_id) as any;
  if (!c) throw fail('音乐记录已删除，此请求编号不能再次生成',404);
  const meta=JSON.parse(c.metadata);
  const status=['processing','review'].includes(c.status) && ['settled','refunded'].includes(meta.billingStatus)?'resolved':c.status;
  return {id:row.id,model:c.model_id,prompt:c.input_text,status,progress:meta.progress || 0,
    result_url:c.result_url || null,cost:c.cost,error:row.error ? publicGenerationError(row.error,[row.upstream_id,JSON.parse(row.payload).model].filter(Boolean)) : null,created_at:c.created_at};
}
export function listMusicTasks(owner:MusicOwner) {
  ensureMusicJobs();
  return (sqlite.prepare('SELECT j.id FROM music_jobs j JOIN contents c ON c.id=j.content_id WHERE j.owner=? ORDER BY j.rowid DESC LIMIT 50').all(ownerKey(owner)) as any[]).map(r=>getMusicTask(r.id,owner));
}
export function musicFile(id:string,owner:MusicOwner) {
  const task=getMusicTask(id,owner);
  if (task.status!=='completed' || !task.result_url) throw fail('音乐文件尚未就绪',409);
  return path.resolve('data/uploads/music',id+'.mp3');
}
export function createMusicTask(input:any,owner:MusicOwner) {
  ensureMusicJobs();
  if (!input || typeof input!=='object' || Array.isArray(input)) throw fail('请求必须是对象');
  const allowed=['model','prompt','lyrics','mode','vocal','tags','client_request_id','expected_cost'];
  if (Object.keys(input).some(k=>!allowed.includes(k))) throw fail('存在不支持的音乐参数');
  if (typeof input.client_request_id!=='string' || !/^[A-Za-z0-9_-]{8,64}$/.test(input.client_request_id)) throw fail('请提供 8–64 位 client_request_id');
  let body:ReturnType<typeof buildMinikeyMusic>;
  try { body=buildMinikeyMusic({model:input.model,prompt:input.prompt,lyrics:input.lyrics,mode:input.mode ?? 'song',vocal:input.vocal ?? 'auto',tags:input.tags ?? []}); }
  catch(e) {throw fail((e as Error).message);}
  const who=ownerKey(owner), requestHash=hash(body);
  return sqlite.transaction(()=>{
    const account=owner.userId?sqlite.prepare('SELECT is_active,org_id FROM users WHERE id=?').get(owner.userId) as any:null;
    if(owner.userId && !account?.is_active) throw fail('账号不存在或已停用',403);
    const prior=sqlite.prepare('SELECT * FROM music_jobs WHERE owner=? AND request_key=?').get(who,input.client_request_id) as any;
    if (prior) {if(prior.request_hash!==requestHash)throw fail('此请求编号已用于不同内容',409);return getMusicTask(prior.id,owner);}
    if (owner.allowedModels?.length && !owner.allowedModels.includes(body.model)) throw fail('API Key 无此模型权限',403);
    const binding=musicBinding(body.model,owner.userId);
    if (input.expected_cost!==undefined && (typeof input.expected_cost!=='number' || Math.abs(input.expected_cost-binding.quote.cost)>0.000001)) throw fail('售价已变化，请刷新后确认',409);
    const reservation=owner.reserve ? owner.reserve(binding.quote.cost,body.model,binding.quote.pricingSnapshot)
      : reserveUserCharge(owner.userId!,binding.quote.cost,'generate_music',{model:body.model,pricingSnapshot:binding.quote.pricingSnapshot});
    const id=randomUUID();
    const c=sqlite.prepare("INSERT INTO contents(user_id,type,title,input_text,model_id,cost,metadata,status) VALUES(?,'music',?,?,?,?,?,'processing')")
      .run(owner.userId || 0,body.prompt.slice(0,80),body.prompt,body.model,binding.quote.cost,JSON.stringify({billingReservationId:reservation.id,billingStatus:'reserved',musicTaskId:id,tokenId:owner.tokenId}));
    linkReservationContent(reservation.id,Number(c.lastInsertRowid));
    if(account?.org_id) sqlite.prepare('UPDATE contents SET org_id=? WHERE id=?').run(account.org_id,Number(c.lastInsertRowid));
    sqlite.prepare('INSERT INTO music_jobs(id,owner,request_key,request_hash,content_id,channel_id,credential_hash,payload,state) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,who,input.client_request_id,requestHash,Number(c.lastInsertRowid),binding.channelId,fingerprint(binding.channel),JSON.stringify({...body,model:binding.draft.upstreamModel,...(binding.draft.upstreamChannel?{chan:binding.draft.upstreamChannel}:{})}),'queued');
    return getMusicTask(id,owner);
  }).immediate();
}
function metadata(row:any,patch:any,status?:string) {
  const c=sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(row.content_id) as any;
  sqlite.prepare('UPDATE contents SET metadata=?,status=COALESCE(?,status) WHERE id=?').run(JSON.stringify({...JSON.parse(c.metadata),...patch}),status || null,row.content_id);
}
function hold(row:any,message:string,kind:string) {
  sqlite.transaction(()=>{
    sqlite.prepare("UPDATE music_jobs SET state=?,error=?,next_poll=? WHERE id=?").run(row.upstream_id?'accepted':'review',message,Date.now()+15000,row.id);
    metadata(row,{error:message,requiresReview:true,reviewKind:kind},'review');
    const c=sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(row.content_id) as any;
    sqlite.prepare("UPDATE billing_reservations SET state='review' WHERE id=? AND state='reserved'").run(JSON.parse(c.metadata).billingReservationId);
  })();
}
/** Terminal content, funds and queue state change together, including token/org receipts. */
function finish(row:any,outcome:'completed'|'failed',message='',resultUrl?:string) {
  sqlite.transaction(()=>{
    const c=sqlite.prepare('SELECT * FROM contents WHERE id=?').get(row.content_id) as any, meta=JSON.parse(c.metadata);
    const r=sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
    if (!r) throw new Error('音乐预扣账本缺失');
    if (!['reserved','review'].includes(r.state)) {sqlite.prepare("UPDATE music_jobs SET state='resolved' WHERE id=?").run(row.id);return;}
    const receipt=JSON.parse(r.receipt), context=JSON.parse(r.context), refund=outcome==='failed'?r.amount:0;
    const captured=captureFundEntries(sqlite,()=>withFundContext(sqlite,{contentId:row.content_id,kind:'refund'},()=>{
      if (!refund) return;
      if (context.tokenId) {
        if (context.unlimitedToken && context.userId) BalanceService.refundToSource(context.userId,refund,receipt.balanceDeduction?.source || 'user',receipt.balanceDeduction?.orgId,'music_refund');
        TokenService.refundBalance(context.tokenId,refund);
      } else BalanceService.refundToSource(context.userId,refund,receipt.source,receipt.orgId,'music_refund');
    }));
    const state=outcome==='completed'?'settled':'refunded';
    sqlite.prepare("UPDATE billing_reservations SET state=?,actual=?,context=?,settled_at=datetime('now') WHERE id=?").run(state,outcome==='completed'?r.amount:0,JSON.stringify({...context,fundLedgerEntryIds:[...new Set([...(context.fundLedgerEntryIds || []),...captured.entryIds])]}),r.id);
    sqlite.prepare('UPDATE contents SET status=?,cost=?,result_url=?,metadata=? WHERE id=?').run(outcome,outcome==='completed'?r.amount:0,resultUrl || null,JSON.stringify({...meta,error:message,billingStatus:state,requiresReview:false,reviewKind:null,progress:outcome==='completed'?100:0,refundAmount:refund}),row.content_id);
    sqlite.prepare('UPDATE music_jobs SET state=?,error=? WHERE id=?').run(outcome,message || null,row.id);
  }).immediate();
}
async function saveAudio(c:MinikeyChannel,row:any) {
  const response=await fetchMinikeyFile(c,'music',row.upstream_id);
  if (!response.ok || !response.body) throw new Error('音乐文件下载 HTTP '+response.status);
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let bytes=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;bytes+=value.length;if(bytes>100*1024*1024)throw new Error('音乐文件超过 100 MB 保存上限');chunks.push(value);}}
  finally {await reader.cancel().catch(()=>{});}
  const buffer=Buffer.concat(chunks);
  if (buffer.length<4 || !(buffer.subarray(0,3).toString()==='ID3' || buffer[0]===255 && (buffer[1]&224)===224)) throw new Error('音乐下载结果不是 MP3 文件');
  const dir=path.resolve('data/uploads/music');await fs.mkdir(dir,{recursive:true});
  const target=path.join(dir,row.id+'.mp3'),temp=target+'.'+randomUUID()+'.tmp';
  try {await fs.writeFile(temp,buffer,{flag:'wx'});await fs.rename(temp,target);}finally{await fs.rm(temp,{force:true});}
  const url='/uploads/music/'+row.id+'.mp3';
  const content=sqlite.prepare('SELECT user_id FROM contents WHERE id=?').get(row.content_id) as any;
  registerUpload(url,content.user_id);return url;
}
export async function processMusicTask(id:string) {
  ensureMusicJobs(); const lease=randomUUID();
  const claimed=sqlite.prepare("UPDATE music_jobs SET lease=?,lease_until=? WHERE id=? AND lease_until<? AND state IN ('queued','submitting','accepted') AND next_poll<=?")
    .run(lease,Date.now()+600000,id,Date.now(),Date.now());
  if (!claimed.changes) return;
  try {
    let row=job(id);
    if(!sqlite.prepare('SELECT id FROM contents WHERE id=?').get(row.content_id)) {sqlite.prepare("UPDATE music_jobs SET state='resolved' WHERE id=?").run(id);return;}
    const ledger=sqlite.prepare("SELECT r.state FROM contents c JOIN billing_reservations r ON r.id=json_extract(c.metadata,'$.billingReservationId') WHERE c.id=?").get(row.content_id) as any;
    if (!ledger) {hold(row,'音乐预扣账本缺失，停止处理并等待核实','settlement');return;}
    if (!['reserved','review'].includes(ledger.state)) {
      sqlite.prepare("UPDATE music_jobs SET state='resolved',error=? WHERE id=?").run('该订单已人工结算，已停止自动处理',id);
      metadata(row,{requiresReview:false,progressText:'订单已人工结算'},'resolved');return;
    }
    const c=sqlite.prepare('SELECT * FROM channels WHERE id=?').get(row.channel_id) as any;
    const channel={baseUrl:c?.base_url,apiKey:c?.api_key,timeout:120000};
    if (!c || c.type!=='minikey' || fingerprint(channel)!==row.credential_hash) {
      if(row.state==='queued'&&!row.upstream_id) finish(row,'failed','提交前渠道或凭据已变化，未发送生成请求');
      else hold(row,'原音乐渠道凭据已变化，需恢复原凭据后查询','configuration');return;
    }
    if (!row.upstream_id) {
      if (row.state==='submitting') {hold(row,'服务在提交期间中断，受理结果未知；保留原请求，不自动重新生成','submission');return;}
      if (!c.status) {finish(row,'failed','提交前渠道已停用，未发送生成请求');return;}
      try {
        const content=sqlite.prepare('SELECT model_id,user_id FROM contents WHERE id=?').get(row.content_id) as any;
        const current=musicBinding(content.model_id,content.user_id || undefined),payload=JSON.parse(row.payload);
        if(current.channelId!==row.channel_id || current.draft.upstreamModel!==payload.model || (current.draft.upstreamChannel || null)!==(payload.chan || null)) throw new Error('模型线路已修改');
      }catch(e){finish(row,'failed','提交前音乐模型已停用或配置变化，未发送生成请求');return;}
      const submitted=await submitMinikey(channel,'music',JSON.parse(row.payload),()=>{
        sqlite.prepare("UPDATE music_jobs SET state='submitting' WHERE id=? AND lease=?").run(id,lease);
      },upstreamId=>{
        sqlite.transaction(()=>{
          const duplicate=sqlite.prepare('SELECT id FROM music_jobs WHERE upstream_id=? AND channel_id=? AND credential_hash=? AND id<>? LIMIT 1').get(upstreamId,row.channel_id,row.credential_hash,id);
          sqlite.prepare("UPDATE music_jobs SET upstream_id=?,state='accepted' WHERE id=?").run(upstreamId,id);
          metadata(row,{upstreamTaskId:upstreamId,submissionPhase:'accepted'});
          if (duplicate) finish(row,'failed','上游复用了已受理的音乐任务，本次重复订单已退费；请稍后再创建新作品');
        })();
      });
      row=job(id);
      if (row.state==='failed') return;
      try {
        const initial=normalizeMinikeyTask(channel,'music',row.upstream_id,submitted.raw);
        if (['completed','failed'].includes(initial.status)) {row.receipt=JSON.stringify(initial);sqlite.prepare('UPDATE music_jobs SET receipt=? WHERE id=?').run(row.receipt,id);}
      }catch(e){if(!(e instanceof MinikeyError))throw e;}
    }
    const result=row.receipt?JSON.parse(row.receipt):await pollMinikey(channel,'music',row.upstream_id);
    if (result.status==='failed') {finish(row,'failed',result.error);return;}
    if (result.status==='completed') {sqlite.prepare('UPDATE music_jobs SET receipt=? WHERE id=?').run(JSON.stringify(result),id);const url=await saveAudio(channel,row);finish(row,'completed','',url);return;}
    sqlite.prepare("UPDATE music_jobs SET state='accepted',error=NULL,next_poll=? WHERE id=?").run(Date.now()+8000,id);
    metadata(row,{progress:result.progress,requiresReview:false,error:null,reviewKind:null},'processing');
  } catch(e) {
    const row=job(id), error=e as Error;
    if (!row.upstream_id && error instanceof MinikeyError && error.confirmedFailure) finish(row,'failed',error.message);
    else {
      const original=sqlite.prepare('SELECT api_key FROM channels WHERE id=?').get(row.channel_id) as any;
      hold(row,error instanceof MinikeyError ? error.message : transportDiagnostic('miniKey',row.upstream_id?'音乐查询/保存':'音乐提交',error,original?.api_key || ''),row.upstream_id?'query':'submission');
    }
  } finally {sqlite.prepare('UPDATE music_jobs SET lease=NULL,lease_until=0 WHERE id=? AND lease=?').run(id,lease);}
}
export async function resumeMusicTasks() {
  ensureMusicJobs();
  const rows=sqlite.prepare("SELECT id FROM music_jobs WHERE state IN ('queued','submitting','accepted') AND lease_until<? AND next_poll<=? ORDER BY next_poll LIMIT 3").all(Date.now(),Date.now()) as any[];
  await Promise.allSettled(rows.map(r=>processMusicTask(r.id)));
}
let timer:ReturnType<typeof setInterval>|undefined;
export function startMusicWorker() {
  if(timer)return;void resumeMusicTasks();timer=setInterval(()=>void resumeMusicTasks(),8000);timer.unref();
}
