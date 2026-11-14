import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sqlite } from '../db/index.js';
import { createSunoMusicTask, ensureSunoMusicStorage, processSunoMusicTask, publicSunoFields, sunoMusicFile } from './sunoMusicJobs.js';
import type { MusicTask } from '../../shared/sunoMusic.js';
import { pollMinikey, fetchMinikeyFile, MinikeyError, type MinikeyChannel } from './minikeyAdapter.js';
import { ensureBillingReservations } from './billingReservation.js';
import { BalanceService } from './balanceService.js';
import { TokenService } from './tokenService.js';
import { captureFundEntries, withFundContext } from '../db/fundLedger.js';
import { registerUpload } from './uploadAccess.js';
import type { PricingSnapshot } from './pricingService.js';
import { transportDiagnostic } from './upstreamDiagnostic.js';
import { publicGenerationError } from '../../shared/generationMessages.js';

export type MusicOwner = { userId?:number|null; tokenId?:number; allowedModels?:string[];
  reserve?:(cost:number,model:string,snapshot?:PricingSnapshot,operation?:string)=>{id:string} };
const fail=(message:string,status=400)=>Object.assign(new Error(message),{status});
const fingerprint=(c:MinikeyChannel)=>createHash('sha256').update(JSON.stringify([c.baseUrl,c.apiKey])).digest('hex');
export function ensureMusicJobs() {
  ensureBillingReservations();
  sqlite.exec(`CREATE TABLE IF NOT EXISTS music_jobs (
    id TEXT PRIMARY KEY, owner TEXT NOT NULL, request_key TEXT NOT NULL, request_hash TEXT NOT NULL,
    content_id INTEGER NOT NULL UNIQUE, channel_id INTEGER NOT NULL, credential_hash TEXT NOT NULL,
    payload TEXT NOT NULL, upstream_id TEXT, state TEXT NOT NULL, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
    next_poll INTEGER NOT NULL DEFAULT 0, error TEXT, UNIQUE(owner,request_key));`);
  if (!sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='music_results_job'").get()) {
    sqlite.transaction(ensureSunoMusicStorage).immediate();
  }
}
export function ownerKey(owner:MusicOwner) {
  if (owner.tokenId) return 'token:'+owner.tokenId;
  if (owner.userId) return 'user:'+owner.userId;
  throw fail('请先登录',401);
}
function job(id:string) { return sqlite.prepare('SELECT * FROM music_jobs WHERE id=?').get(id) as any; }
export function getMusicTask(id:string,owner:MusicOwner):MusicTask {
  ensureMusicJobs(); const row=job(id);
  if (!row || row.owner!==ownerKey(owner)) throw fail('音乐任务不存在',404);
  const c=sqlite.prepare('SELECT * FROM contents WHERE id=?').get(row.content_id) as any;
  if (!c) throw fail('音乐记录已删除，此请求编号不能再次生成',404);
  const meta=JSON.parse(c.metadata);
  const status=['processing','review'].includes(c.status) && ['settled','refunded'].includes(meta.billingStatus)?'resolved':c.status;
  return {id:row.id,model:c.model_id,prompt:c.input_text,status,progress:meta.progress || 0, operation:null,results:[],
    result_url:c.result_url || null,cost:c.cost,error:row.error ? publicGenerationError(row.error,[row.upstream_id,JSON.parse(row.payload).model].filter(Boolean)) : null,created_at:c.created_at,...(row.provider === 'suno-api' ? publicSunoFields(row,c,meta) : {})};
}
export function getMusicTaskByRequest(key:string,owner:MusicOwner) {
  ensureMusicJobs();
  const row=sqlite.prepare('SELECT id FROM music_jobs WHERE owner=? AND request_key=?').get(ownerKey(owner),key) as {id:string}|undefined;
  if(!row)throw fail('音乐订单不存在',404);
  return getMusicTask(row.id,owner);
}
export function listMusicTasks(owner:MusicOwner) {
  ensureMusicJobs();
  return (sqlite.prepare('SELECT j.id FROM music_jobs j JOIN contents c ON c.id=j.content_id WHERE j.owner=? ORDER BY j.rowid DESC LIMIT 50').all(ownerKey(owner)) as any[]).map(r=>getMusicTask(r.id,owner));
}
export function musicFile(id:string,owner:MusicOwner,resultId?:string) {
  const task=getMusicTask(id,owner);
  if (task.operation) return sunoMusicFile(id,resultId);
  if (resultId && resultId!=='default') throw fail('音乐结果不存在',404);
  if (task.status!=='completed' || !task.result_url) throw fail('音乐文件尚未就绪',409);
  return path.resolve('data/uploads/music',id+'.mp3');
}
export function createMusicTask(input:unknown,owner:MusicOwner,file?:{path:string; name:string; mime:string; digest:string}) {
  ensureMusicJobs();
  return createSunoMusicTask(input,owner,file);
}
export function musicMetadata(row:any,patch:any,status?:string) {
  const c=sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(row.content_id) as any;
  sqlite.prepare('UPDATE contents SET metadata=?,status=COALESCE(?,status) WHERE id=?').run(JSON.stringify({...JSON.parse(c.metadata),...patch}),status || null,row.content_id);
}
export function holdMusic(row:any,message:string,kind:string,retryMs=15000) {
  sqlite.transaction(()=>{
    sqlite.prepare("UPDATE music_jobs SET state=?,error=?,next_poll=? WHERE id=?").run(kind==='submission'||kind==='partial'||kind==='conflict'||!row.upstream_id?'review':'accepted',message,Date.now()+retryMs,row.id);
    musicMetadata(row,{error:message,requiresReview:true,reviewKind:kind},'review');
    const c=sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(row.content_id) as any;
    sqlite.prepare("UPDATE billing_reservations SET state='review' WHERE id=? AND state='reserved'").run(JSON.parse(c.metadata).billingReservationId??null);
  })();
}
/** Terminal content, funds and queue state change together, including token/org receipts. */
export function finishMusic(row:any,outcome:'completed'|'failed'|'cancelled',message='',resultUrl?:string) {
  sqlite.transaction(()=>{
    const c=sqlite.prepare('SELECT * FROM contents WHERE id=?').get(row.content_id) as any, meta=JSON.parse(c.metadata);
    const r=sqlite.prepare('SELECT * FROM billing_reservations WHERE id=?').get(meta.billingReservationId??null) as any;
    if (!r && meta.billingStatus==='free' && !meta.billingReservationId) {
      sqlite.prepare('UPDATE contents SET status=?,cost=0,result_url=?,metadata=? WHERE id=?')
        .run(outcome,resultUrl||null,JSON.stringify({...meta,error:message,requiresReview:false,reviewKind:null,progress:outcome==='completed'?100:0}),row.content_id);
      sqlite.prepare('UPDATE music_jobs SET state=?,error=? WHERE id=?').run(outcome,message||null,row.id);
      return;
    }
    if (!r) throw new Error('音乐预扣账本缺失');
    if (!['reserved','review'].includes(r.state)) {sqlite.prepare("UPDATE music_jobs SET state='resolved' WHERE id=?").run(row.id);return;}
    const receipt=JSON.parse(r.receipt), context=JSON.parse(r.context), refund=outcome==='completed'?0:r.amount;
    const captured=captureFundEntries(sqlite,()=>withFundContext(sqlite,{contentId:row.content_id,kind:'refund'},()=>{
      if (!refund) return;
      const wallet= (userId:number,source:'user'|'org',orgId:number|undefined) => {
        const present=source==='org'
          ? sqlite.prepare('SELECT id FROM organizations WHERE id=?').get(orgId??null)
          : sqlite.prepare('SELECT id FROM users WHERE id=?').get(userId??null);
        if(!present)throw new Error('音乐订单原扣款账户不存在，需要人工核对');
        BalanceService.refundToSource(userId,refund,source,orgId,'music_refund');
      };
      if (context.tokenId) {
        if (!sqlite.prepare('SELECT id FROM api_tokens WHERE id=?').get(context.tokenId)) throw new Error('原扣费令牌已删除，需要人工核对');
        if (['organization_balance','user_balance'].includes(receipt.target)) {
          if (!context.userId || !['org','user'].includes(receipt.balanceDeduction?.source)) throw new Error('音乐订单原扣款来源缺失');
          wallet(context.userId,receipt.balanceDeduction.source,receipt.balanceDeduction.orgId);
        } else if (receipt.target!=='api_token') throw new Error('音乐订单令牌扣款来源缺失');
        TokenService.refundBalance(context.tokenId,refund);
      } else {
        if (!context.userId || !['org','user'].includes(receipt.source)) throw new Error('音乐订单原扣款来源缺失');
        wallet(context.userId,receipt.source,receipt.orgId);
      }
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
    const row=job(id);
    if(!sqlite.prepare('SELECT id FROM contents WHERE id=?').get(row.content_id)) {sqlite.prepare("UPDATE music_jobs SET state='resolved' WHERE id=?").run(id);return;}
    if(row.provider==='suno-api') {await processSunoMusicTask(row,lease);return;}
    if(!row.upstream_id) {
      if(row.state==='queued') finishMusic(row,'failed','旧音乐渠道已关闭新提交，本单未向上游发送');
      else holdMusic(row,'旧音乐订单提交结果未知，请以原单回执和账单核对','submission');
      return;
    }
    const ledger=sqlite.prepare("SELECT r.state FROM contents c JOIN billing_reservations r ON r.id=json_extract(c.metadata,'$.billingReservationId') WHERE c.id=?").get(row.content_id) as any;
    if (!ledger) {holdMusic(row,'音乐预扣账本缺失，停止处理并等待核实','settlement');return;}
    if (!['reserved','review'].includes(ledger.state)) {
      sqlite.prepare("UPDATE music_jobs SET state='resolved',error=? WHERE id=?").run('该订单已人工结算，已停止自动处理',id);
      musicMetadata(row,{requiresReview:false,progressText:'订单已人工结算'},'resolved');return;
    }
    const c=sqlite.prepare('SELECT * FROM channels WHERE id=?').get(row.channel_id) as any;
    const channel={baseUrl:c?.base_url,apiKey:c?.api_key,timeout:120000};
    if (!c || c.type!=='minikey' || fingerprint(channel)!==row.credential_hash) {
      holdMusic(row,'旧音乐订单原凭据已变化，请核对原任务','configuration');return;
    }
    const result=row.receipt?JSON.parse(row.receipt):await pollMinikey(channel,'music',row.upstream_id);
    if (result.status==='failed') {finishMusic(row,'failed',result.error);return;}
    if (result.status==='completed') {sqlite.prepare('UPDATE music_jobs SET receipt=? WHERE id=?').run(JSON.stringify(result),id);const url=await saveAudio(channel,row);finishMusic(row,'completed','',url);return;}
    sqlite.prepare("UPDATE music_jobs SET state='accepted',error=NULL,next_poll=? WHERE id=?").run(Date.now()+8000,id);
    musicMetadata(row,{progress:result.progress,requiresReview:false,error:null,reviewKind:null},'processing');
  } catch(e) {
    const row=job(id), error=e as Error;
    if(row.lease===lease) {
      const original=sqlite.prepare('SELECT api_key FROM channels WHERE id=?').get(row.channel_id) as any;
      holdMusic(row,error instanceof MinikeyError ? error.message : transportDiagnostic(row.provider==='suno-api'?'Suno':'miniKey',row.upstream_id?'音乐查询/保存':'音乐提交',error,original?.api_key || ''),row.upstream_id?'query':row.state==='queued'?'settlement':'submission');
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
  if(timer)return;
  const scan=()=>void resumeMusicTasks().catch(error=>console.error("音乐任务扫描失败",transportDiagnostic("音乐队列","扫描",error)));
  scan();
  timer=setInterval(scan,8000);
  timer.unref();
}
