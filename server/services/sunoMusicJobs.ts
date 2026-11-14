import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { sqlite } from '../db/index.js';
import { linkReservationContent, reserveUserCharge } from './billingReservation.js';
import { musicBinding, musicOperationQuote } from './musicModelRegistry.js';
import { finishMusic, getMusicTask, holdMusic, musicMetadata, ownerKey, type MusicOwner } from './musicGenerationService.js';
import { musicFailure, musicHash, musicLocalId, parseSunoInput, sunoSubmission } from './sunoMusicInput.js';
import { cancelSunoUpload, deleteSunoVoice, fetchSunoAudio, findSunoEnhancedVoice, findSunoVoiceSongs, querySunoSongs, readSunoReceipt, submitSuno, sunoBase,
  SunoError, sunoId, sunoSongTerminal, type SunoChannel, type SunoReceipt, type SunoSong, type SunoSubmission } from './sunoMusicAdapter.js';
import { transportDiagnostic } from './upstreamDiagnostic.js';
import { publicGenerationError } from '../../shared/generationMessages.js';
import { MUSIC_OPERATION_LABELS, SUNO_CHANNEL_TYPE, freeMusicOperation, songOperation, voiceOperation, type MusicOperation, type MusicTask } from '../../shared/sunoMusic.js';

export const musicPrivateDir=()=>path.resolve('data/private-music');
export type MusicUpload={path:string;name:string;mime:string;digest:string};
type StoredSpec=SunoSubmission & {title?:string; assetId?:string; voiceId?:string; rights:boolean; selfVoice:boolean};
type Row={
  id:string;owner:string;request_key:string;request_hash:string;content_id:number;channel_id:number;credential_hash:string;
  provider:string;operation:MusicOperation;payload:string;receipt:string|null;upstream_id:string|null;submission_key:string;
  state:string;lease:string|null;lease_until:number;next_poll:number;error:string|null;replayed:number;deleted:number;
};
type Track={id:string;upstream_id:string;status:string;title:string|null;error:string|null;saved:number};
const fingerprint=(c:SunoChannel)=>musicHash([c.baseUrl,c.apiKey]);
const job=(id:string)=>sqlite.prepare('SELECT * FROM music_jobs WHERE id=?').get(id) as Row|undefined;
const tracks=(id:string)=>sqlite.prepare('SELECT * FROM music_results WHERE job_id=? ORDER BY rowid').all(id) as Track[];
const readReceipt=(row:Row)=>row.receipt ? JSON.parse(row.receipt) as SunoReceipt : undefined;
const queuedStatuses=new Set(['queued','pending','submitted','processing','streaming','playable']);
const finalStates=new Set(['completed','failed','cancelled','resolved']);
const localAsset=(row:Row)=>voiceOperation(row.operation)?{voice_id:row.id}:{asset_id:row.id};

export function ensureSunoMusicStorage() {
  const existing=new Set((sqlite.prepare('PRAGMA table_info(music_jobs)').all() as {name:string}[]).map(c=>c.name));
  for(const [name,definition] of Object.entries({receipt:'TEXT',provider:"TEXT NOT NULL DEFAULT 'minikey'",operation:'TEXT',
    submission_key:'TEXT',replayed:'INTEGER NOT NULL DEFAULT 0',deleted:'INTEGER NOT NULL DEFAULT 0'})) {
    if(!existing.has(name))sqlite.exec('ALTER TABLE music_jobs ADD COLUMN '+name+' '+definition);
  }
  sqlite.exec(`CREATE TABLE IF NOT EXISTS music_results (
    id TEXT PRIMARY KEY, job_id TEXT NOT NULL, channel_id INTEGER NOT NULL,
    upstream_id TEXT NOT NULL, status TEXT NOT NULL, title TEXT, error TEXT, saved INTEGER NOT NULL DEFAULT 0,
    UNIQUE(channel_id,upstream_id), UNIQUE(job_id,upstream_id)
  ); CREATE INDEX IF NOT EXISTS music_results_job ON music_results(job_id);
  CREATE TABLE IF NOT EXISTS music_recovery_audit (
    id INTEGER PRIMARY KEY, job_id TEXT NOT NULL, admin_id INTEGER NOT NULL, evidence TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now'))
  );`);
}
function requireAsset(id:string,owner:string,kind:'song'|'voice') {
  const row=job(id);
  if(!row || row.owner!==owner || row.provider!==SUNO_CHANNEL_TYPE || row.deleted ||
    (kind==='voice'?!voiceOperation(row.operation):!['upload','enhanced_upload'].includes(row.operation))) throw musicFailure('素材或音色不存在',404);
  if(row.state!=='completed')throw musicFailure('素材或音色尚未就绪',409);
  return row;
}
function requireSongSource(id:string,owner:string) {
  const row=requireAsset(id,owner,'song');
  const value=readReceipt(row);
  if(!value || (value.kind!=='upload'&&value.kind!=='enhanced') || !value.clip) throw musicFailure('歌曲素材缺少有效来源编号',409);
  return {row,value,clip:value.clip};
}
function requireVoiceSource(id:string,owner:string) {
  const row=requireAsset(id,owner,'voice');
  const value=readReceipt(row);
  if(value?.kind!=='voice'||value.status!=='ready')throw musicFailure('音色尚未就绪',409);
  return {row,value};
}
function recheckAsset(row:Row, source:Row) {
  if(source.channel_id!==row.channel_id||source.credential_hash!==row.credential_hash)throw musicFailure('素材和音色必须使用原音乐渠道与同一上游凭据',409);
}

export function createSunoMusicTask(input:unknown, owner:MusicOwner, file?:MusicUpload) {
  const i=parseSunoInput(input,Boolean(file));
  const who=ownerKey(owner);
  const requestHash=musicHash([i.op,{...i,expected:undefined},file?.digest,file?.name,file?.mime]);
  return sqlite.transaction(()=>{
    const account=owner.userId?sqlite.prepare('SELECT is_active,org_id FROM users WHERE id=?').get(owner.userId) as any:null;
    if(owner.userId&&!account?.is_active)throw musicFailure('账号不存在或已停用',403);
    if(!owner.userId && !songOperation(i.op))throw musicFailure('素材操作需要绑定用户的 API Key',403);
    const prior=sqlite.prepare('SELECT * FROM music_jobs WHERE owner=? AND request_key=?').get(who,i.key) as Row|undefined;
    if(prior) {
      if(prior.request_hash!==requestHash)throw musicFailure('此请求编号已用于不同内容',409);
      return {task:getMusicTask(prior.id,owner),retainedFile:false};
    }
    if(owner.allowedModels?.length&&!owner.allowedModels.includes(i.model))throw musicFailure('API Key 无此模型权限',403);
    const binding=musicBinding(i.model,owner.userId);
    const source=i.assetId?requireSongSource(i.assetId,who):undefined;
    const voice=i.voiceId?requireVoiceSource(i.voiceId,who):undefined;
    const channel=binding.channel, credential=fingerprint(channel);
    for(const dependency of [source?.row,voice?.row]) {
      if(dependency&&(dependency.channel_id!==channel.id||dependency.credential_hash!==credential))
        throw musicFailure('素材与音色须使用同一上游账号及原凭据',409);
    }
    if(source&&voice&&voice.value.clip===source.clip)throw musicFailure('翻唱原曲不能与创建音色的样本相同');
    const {cost,snapshot}=musicOperationQuote(binding,i.op,i.maxMode,owner.userId);
    if(i.expected!==undefined&&Math.abs(i.expected-cost)>0.000001)throw musicFailure('售价已变化，请刷新后确认',409);
    if(i.op==='enhanced_voice'||i.op==='enhanced_upload') {
      if(i.expected===undefined)throw musicFailure('请提交已确认的强化处理报价 expected_cost');
    }
    const id=randomUUID();
    const submission:StoredSpec={...sunoSubmission(i,source&&{clip:source.clip,audio:source.value.audio,title:source.value.title},
      voice&&{id:voice.value.id},file&&{file:file.path,mime:file.mime,name:file.name}),
      title:i.title||file?.name,assetId:i.assetId,voiceId:i.voiceId,rights:i.rights,selfVoice:i.selfVoice};
    const operation='music_'+i.op;
    const reservation=freeMusicOperation(i.op)?undefined:owner.reserve?owner.reserve(cost,i.model,snapshot,operation)
      :reserveUserCharge(owner.userId!,cost,operation,{model:i.model,pricingSnapshot:snapshot});
    const prompt=i.prompt??i.lyrics??'';
    const metadata={billingReservationId:reservation?.id,billingStatus:reservation?'reserved':'free',musicTaskId:id,tokenId:owner.tokenId,
      musicOperation:i.op,channelId:channel.id,rightsConfirmed:i.rights,selfVoiceConfirmed:i.selfVoice};
    const content=sqlite.prepare("INSERT INTO contents(user_id,org_id,type,title,input_text,model_id,cost,metadata,status) VALUES(?,?,'music',?,?,?,?,?,'processing')")
      .run(owner.userId||0,account?.org_id||null,submission.title||MUSIC_OPERATION_LABELS[i.op],prompt,i.model,cost,JSON.stringify(metadata));
    if(reservation)linkReservationContent(reservation.id,Number(content.lastInsertRowid));
    sqlite.prepare("INSERT INTO music_jobs (id,owner,request_key,request_hash,content_id,channel_id,credential_hash,payload,state,provider,operation,submission_key) VALUES(?,?,?,?,?,?,?,?,'queued',?,?,?)")
      .run(id,who,i.key,requestHash,Number(content.lastInsertRowid),channel.id,credential,JSON.stringify(submission),SUNO_CHANNEL_TYPE,i.op,id);
    return {task:getMusicTask(id,owner),retainedFile:Boolean(file)};
  }).immediate();
}
function activeChannel(row:Row, requireEnabled=false):SunoChannel {
  const c=sqlite.prepare('SELECT * FROM channels WHERE id=?').get(row.channel_id) as any;
  if(c?.type!==SUNO_CHANNEL_TYPE||!c.api_key?.trim()||requireEnabled&&!c.status)throw musicFailure('原音乐渠道不可用',409);
  const channel={id:c.id,baseUrl:sunoBase(c.base_url),apiKey:c.api_key.trim()};
  if(fingerprint(channel)!==row.credential_hash)throw musicFailure('原音乐渠道凭据已变更，请恢复原凭据后查询',409);
  return channel;
}
function persistSongs(row:Row,songs:SunoSong[]) {
  if(new Set(songs.map(song=>song.id)).size!==songs.length)throw new SunoError('上游回执包含重复歌曲编号');
  for(const song of songs) {
    const owner=sqlite.prepare('SELECT job_id,status FROM music_results WHERE channel_id=? AND upstream_id=?').get(row.channel_id,song.id) as {job_id:string;status:string}|undefined;
    if(owner&&owner.job_id!==row.id)throw new SunoError('上游歌曲编号已关联另一订单，需要核对原回执');
    if(owner?.status==='scene_conflict')continue;
    if(owner && sunoSongTerminal(owner.status) && owner.status!==song.status) {
      if(sunoSongTerminal(song.status))throw new SunoError('歌曲终态回执冲突，需要核对');
      continue;
    }
    sqlite.prepare(`INSERT INTO music_results(id,job_id,channel_id,upstream_id,status,title,error)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(job_id,upstream_id) DO UPDATE SET status=excluded.status,
      title=COALESCE(excluded.title,music_results.title),error=COALESCE(excluded.error,music_results.error)`)
      .run(randomUUID(),row.id,row.channel_id,song.id,song.status,song.title??null,song.error??null);
  }
}
function persistReceipt(row:Row,receipt:SunoReceipt) {
  sqlite.transaction(()=>{
    const current=job(row.id)!;
    if(current.lease!==row.lease||finalStates.has(current.state))throw new SunoError('订单处理权已变化，需要核对原回执');
    const id=receipt.kind==='songs'?receipt.songs[0]?.id:receipt.id;
    if(!id)throw new SunoError('回执缺少有效编号');
    if(current.upstream_id&&current.upstream_id!==id)throw new SunoError('上游回执编号冲突');
    if(receipt.kind==='request'||receipt.kind==='enhanced'){
      const prior=sqlite.prepare('SELECT id FROM music_jobs WHERE provider=? AND channel_id=? AND operation=? AND upstream_id=? AND id<>?').get(SUNO_CHANNEL_TYPE,row.channel_id,row.operation,id,row.id);
      if(prior)throw new SunoError('上游回执已关联另一订单，需要核对');
    }
    // First save the receipt and canonical ID, including mixed/partial response evidence.
    const priorReceipt=readReceipt(current);
    const observed=receipt.kind==='voice'&&priorReceipt?.kind==='voice'&&!receipt.taskId&&priorReceipt.taskId
      ?{...receipt,taskId:priorReceipt.taskId}:receipt;
    sqlite.prepare("UPDATE music_jobs SET receipt=?,upstream_id=?,state='accepted' WHERE id=?").run(JSON.stringify(observed),id,row.id);
    musicMetadata(row,{upstreamTaskId:id,submissionPhase:'accepted'});
  }).immediate();
  if(receipt.kind==='request'||receipt.kind==='songs')sqlite.transaction(()=>persistSongs(row,receipt.songs)).immediate();
}
function continuePoll(row:Row,progress=0) {
  sqlite.prepare("UPDATE music_jobs SET state='accepted',error=NULL,next_poll=? WHERE id=?").run(Date.now()+8000,row.id);
  musicMetadata(row,{progress,reviewKind:null,requiresReview:false,error:null},'processing');
}
function outputFile(id:string,resultId:string) {return path.join(musicPrivateDir(),'results',id+'-'+resultId+'.mp3');}
async function saveAudio(row:Row,channel:SunoChannel,resultId:string,upstreamId:string,source?:string) {
  const target=outputFile(row.id,resultId);
  try { if((await fs.stat(target)).size>4)return; } catch(e:any){if(e.code!=='ENOENT')throw e;}
  const response=await fetchSunoAudio(channel,upstreamId,source);
  if(!response.ok||!response.body) { await response.body?.cancel(); throw new SunoError('音乐文件下载 HTTP '+response.status); }
  await fs.mkdir(path.dirname(target),{recursive:true});
  const temp=target+'.'+randomUUID()+'.tmp';
  const file=await fs.open(temp,'wx',0o600);
  const reader=response.body.getReader();
  let total=0,head=Buffer.alloc(0);
  try {
    while(true) {
      const {done,value}=await reader.read();
      if(done)break;
      total+=value.length;
      if(total>100*1024*1024)throw new SunoError('音乐文件超过 100 MB 保存上限');
      if(head.length<4)head=Buffer.concat([head,Buffer.from(value.subarray(0,4-head.length))]);
      await file.writeFile(value);
    }
    if(total<4||!(head.subarray(0,3).toString()==='ID3'||head[0]===255&&(head[1]&224)===224))throw new SunoError('音乐下载结果不是 MP3 文件');
    await file.close();
    await fs.rename(temp,target);
  } finally {await reader.cancel().catch(()=>{});await file.close();await fs.rm(temp,{force:true});}
}
async function collectSongs(row:Row,channel:SunoChannel,receipt:Extract<SunoReceipt,{kind:'request'|'songs'}>,model:string,setStage:(stage:string)=>void) {
  const before=tracks(row.id);
  if(before.length>2) {
    holdMusic(row,'上游返回超过两首歌曲，保留原回执待核对','conflict');return;
  }
  if(before.some(t=>t.status==='scene_conflict')) {
    holdMusic(row,'上游受理的生成场景与请求不一致','conflict');return;
  }
  if(receipt.kind==='request' && receipt.status==='failed' && before.every(t=>t.status==='failed')) {
    setStage('settlement');finishMusic(row,'failed',receipt.error||'上游明确返回受理失败，未提供具体原因');return;
  }
  if(receipt.kind==='request' && receipt.status==='failed') {
    holdMusic(row,'受理单返回失败，但存在已登记的非失败歌曲，需核对原回执','conflict');return;
  }
  if(receipt.kind==='request' && (!['queued','processing','partial','completed'].includes(receipt.status))) {
    holdMusic(row,'上游受理状态不明确，需要核对原回执','query');return;
  }
  const pending=before.filter(t=>!sunoSongTerminal(t.status));
  if(pending.length) {
    const updates=await querySunoSongs(channel,pending.map(t=>t.upstream_id),model);
    sqlite.transaction(()=>persistSongs(row,updates)).immediate();
  }
  let results=tracks(row.id);
  for(const result of results.filter(t=>t.status==='completed'&&!t.saved)) {
    setStage('storage');
    await saveAudio(row,channel,result.id,result.upstream_id);
    sqlite.prepare('UPDATE music_results SET saved=1 WHERE id=?').run(result.id);
  }
  results=tracks(row.id);
  const done=results.filter(t=>t.status==='completed'&&t.saved);
  if(results.some(t=>!sunoSongTerminal(t.status)&&!queuedStatuses.has(t.status))) {
    holdMusic(row,'歌曲查询返回未识别状态，保留原歌曲继续查询','query');return;
  }
  const missing=receipt.kind==='request'&&(results.length<2||['queued','processing'].includes(receipt.status));
  if(!results.length||missing||results.some(t=>!sunoSongTerminal(t.status))) {
    if(receipt.kind==='request'&&receipt.status==='completed'&&results.length<2) {
      holdMusic(row,'上游受理单完成但歌曲回执不完整，继续核对原单','query');return;
    }
    continuePoll(row,Math.floor(done.length*50));return;
  }
  const failure=results.filter(t=>t.status==='failed').map(t=>t.error).find(Boolean);
  setStage('settlement');
  if(!done.length) {
    if(results.length<2) {holdMusic(row,failure||'仅取得一首歌曲的失败回执，需核对另一结果与账单','partial');return;}
    finishMusic(row,'failed',failure||'上游明确返回歌曲失败，未提供具体原因');return;
  }
  if(done.length<2||done.length<results.length) {
    holdMusic(row,failure||'仅取得部分歌曲结果，需核对本次生成实收金额','partial');return;
  }
  finishMusic(row,'completed','','/api/music/'+row.id+'/results/'+done[0].id+'/file');
}

export async function processSunoMusicTask(row:Row,lease:string) {
  let stage='preparation';
  let channel:SunoChannel|undefined;
  try {
    const content=sqlite.prepare('SELECT * FROM contents WHERE id=?').get(row.content_id) as any;
    const meta=JSON.parse(content.metadata||'{}');
    if(meta.billingReservationId) {
      const bill=sqlite.prepare('SELECT state FROM billing_reservations WHERE id=?').get(meta.billingReservationId) as any;
      if(!bill){holdMusic(row,'音乐预扣账本缺失','settlement');return;}
      if(!['reserved','review'].includes(bill.state)) {
        sqlite.prepare("UPDATE music_jobs SET state='resolved',error=NULL WHERE id=?").run(row.id);
        musicMetadata(row,{requiresReview:false,reviewKind:null},'resolved');return;
      }
    } else if(meta.billingStatus!=='free') {holdMusic(row,'缺少音乐预扣凭证','settlement');return;}
    const spec=JSON.parse(row.payload) as StoredSpec;
    const hadSend=row.state!=='queued';
    stage=hadSend?'configuration':'preparation';
    channel=activeChannel(row,!hadSend);
    let r=readReceipt(row);
    const retryExactLookup=(message:string)=>{
      const attempts=Number(meta.musicLookupAttempts||0)+1;
      if(attempts>=3){holdMusic(row,message,'submission');return;}
      sqlite.transaction(()=>{
        sqlite.prepare("UPDATE music_jobs SET state='submitting',error=?,next_poll=? WHERE id=?").run(message,Date.now()+attempts*15000,row.id);
        musicMetadata(row,{error:message,reviewKind:'submission',requiresReview:true,musicLookupAttempts:attempts},'review');
      }).immediate();
    };
    if(!r) {
      if(hadSend) {
        stage='submission';
        if((row.operation==='voice_cover'||row.operation==='sing')&&!row.upstream_id) {
          const found=await findSunoVoiceSongs(channel,row.submission_key,content.model_id,spec.request.song_clip_id);
          if(found.length) {
            r={kind:'songs',songs:found};persistReceipt(row,r);row=job(row.id)!;
          } else {retryExactLookup('上游翻唱回执暂未找到，保留原追踪号供核对');return;}
        } else if(row.operation==='enhanced_voice') {
          const found=await findSunoEnhancedVoice(channel,row.submission_key);
          if(!found){retryExactLookup('强化音色列表暂未找到精确追踪号，保留原订单核对');return;}
          stage='conflict';
          persistReceipt(row,found);row=job(row.id)!;r=readReceipt(row);
        } else if(!['generate','voice','voice_from_clip'].includes(row.operation)||row.replayed) {
          holdMusic(row,'提交期间连接中断，未确认上游是否受理','submission');return;
        }
      }
      if(!r) {
        if(!hadSend) {
          musicBinding(content.model_id,content.user_id||null);
          if(spec.assetId)recheckAsset(row,requireAsset(spec.assetId,row.owner,'song'));
          if(spec.voiceId)recheckAsset(row,requireAsset(spec.voiceId,row.owner,'voice'));
        }
        r=await submitSuno(channel,spec,row.submission_key,()=>{
          const updated=sqlite.prepare("UPDATE music_jobs SET state='submitting',replayed=replayed+? WHERE id=? AND lease=?").run(hadSend?1:0,row.id,lease);
          if(!updated.changes)throw new SunoError('订单处理权已转移');
          stage='submission';
        });
        stage='conflict';
        persistReceipt(row,r);
        row=job(row.id)!;
        r=readReceipt(row)!;
      }
    } else {
      stage='query';
      if(r.conflict && r.kind!=='upload' && r.kind!=='songs' ||
          r.kind==='request' && (r.status!=='failed' && (r.status!=='completed' || tracks(row.id).length<2)) ||
          r.kind==='enhanced' && !(['failed','cancelled'].includes(r.status)||r.status==='completed'&&r.clip&&r.audio) ||
          r.kind==='voice' && !['ready','failed'].includes(r.status)) {
        r=await readSunoReceipt(channel,row.operation,r.id);
        stage='conflict';
        persistReceipt(row,r);
        row=job(row.id)!;
      }
    }
    if(r.conflict) {
      holdMusic(row,r.conflict,r.kind==='upload'||r.kind==='songs'?'conflict':'query');
      return;
    }
    if(r.kind==='voice') {
      const duplicate=sqlite.prepare("SELECT id FROM music_jobs WHERE provider=? AND channel_id=? AND credential_hash=? AND upstream_id=? AND owner<>? AND state='completed' AND deleted<>1 AND operation IN ('voice','enhanced_voice','voice_from_clip')")
        .get(SUNO_CHANNEL_TYPE,row.channel_id,row.credential_hash,r.id,row.owner);
      if(duplicate) {holdMusic(row,'上游音色已关联另一账号，需要核对原回执','conflict');return;}
    }
    if(r.kind==='request'||r.kind==='songs') {
      // Rebuild track records from already saved acceptance if interrupted before the track insert.
      stage='conflict';
      sqlite.transaction(()=>persistSongs(row,r.songs)).immediate();
      stage='query';
      await collectSongs(row,channel,r,content.model_id,value=>{stage=value;});return;
    }
    if(r.status==='failed'||r.kind==='enhanced'&&r.status==='cancelled') {
      stage='settlement';finishMusic(row,r.status==='cancelled'?'cancelled':'failed',r.error||
        (r.status==='cancelled'?'上游已确认取消':'上游确认任务失败，未提供具体原因'));return;
    }
    if(r.kind==='upload'&&r.status==='complete'||r.kind==='voice'&&r.status==='ready') {
      stage='settlement';finishMusic(row,'completed');return;
    }
    if(r.kind==='enhanced'&&r.status==='completed'&&r.clip&&r.audio) {
      stage='storage';
      try { await saveAudio(row,channel,'source',r.clip,r.audio); }
      catch(error) {
        // Refresh the same enhanced upload media link on the next storage attempt.
        const refreshed=await readSunoReceipt(channel,row.operation,r.id);
        if(refreshed.kind==='enhanced'&&refreshed.status==='completed'&&refreshed.clip===r.clip&&refreshed.audio)persistReceipt(row,refreshed);
        throw error;
      }
      stage='settlement';finishMusic(row,'completed');return;
    }
    if((r.kind==='enhanced'&&queuedStatuses.has(r.status))||(r.kind==='voice'&&r.status==='processing')) {continuePoll(row,Number(r.progress)||0);return;}
    holdMusic(row,'上游返回的素材状态或媒体字段不完整，保留原任务核对','query');
  } catch(error:any) {
    const current=job(row.id)!;
    if(current.lease!==lease||finalStates.has(current.state))return;
    const detail=error instanceof SunoError?error.message:transportDiagnostic('Suno',stage,error,channel?.apiKey||'');
    if(stage==='preparation'&&current.state==='queued' || stage==='submission'&&error instanceof SunoError&&error.confirmedRejection&&!current.upstream_id&&!current.replayed) {
      try{finishMusic(current,'failed',detail);}catch(e){holdMusic(current,transportDiagnostic('Suno','结算',e),'settlement');}
      return;
    }
    if(stage==='submission'&&['generate','voice','voice_from_clip','voice_cover','sing','enhanced_voice'].includes(row.operation)&&
      (!current.replayed || ['voice_cover','sing'].includes(row.operation))) {
      const retryMs=Math.max(15000,error instanceof SunoError?error.retryMs:0);
      sqlite.prepare("UPDATE music_jobs SET state='submitting',error=?,next_poll=? WHERE id=?").run(detail,Date.now()+retryMs,row.id);
      musicMetadata(current,{error:detail,reviewKind:'submission',requiresReview:true},'review');return;
    }
    holdMusic(current,detail,stage,Math.max(15000,error instanceof SunoError?error.retryMs:0));
  }
}

function publicError(error:string|null|undefined,ids:(string|null|undefined)[]=[]) {
  return error?publicGenerationError(error,['Suno',...ids.filter((id):id is string=>Boolean(id))]):null;
}
export function publicSunoFields(row:Row,c:any,meta:any):Partial<MusicTask> {
  const observed=readReceipt(row);
  const results=tracks(row.id).map(t=>({id:t.id,status:t.saved?'completed':t.status==='completed'?'saving':t.status,
    title:publicError(t.title)||undefined,error:publicError(t.error,[t.upstream_id]),
    result_url:t.saved?'/api/music/'+row.id+'/results/'+t.id+'/file':null}));
  return {operation:row.operation,title:c.title,results,error:publicError(row.error,[row.upstream_id,...(observed?.kind==='songs'?observed.songs.map(s=>s.id):[])]),
    status:row.deleted===1?'deleted':row.deleted===2?'deleting':
      ['processing','review'].includes(c.status)&&['refunded','settled'].includes(meta.billingStatus)?'resolved':
      meta.reviewKind==='partial'&&results.some(t=>t.result_url)?'partial':c.status,
    review_kind:meta.reviewKind??null,billing_status:meta.billingStatus,refund_amount:meta.refundAmount||0,
    ...(row.state==='completed'&&!songOperation(row.operation)&&!row.deleted?localAsset(row):{}),
    can_cancel:row.operation==='enhanced_upload'&&(row.state==='queued'||row.state==='accepted'&&observed?.kind==='enhanced'&&observed.status==='queued')};
}
export function sunoMusicFile(id:string,resultId?:string) {
  const row=job(id);
  if(!row)throw musicFailure('任务不存在',404);
  if(resultId!==undefined&&!musicLocalId(resultId))throw musicFailure('音乐结果不存在',404);
  const track=tracks(id).find(t=>t.saved&&(!resultId||t.id===resultId));
  if(!track)throw musicFailure('音乐文件尚未就绪',409);
  return outputFile(id,track.id);
}
export function sunoSourceFile(id:string) {
  const row=job(id);
  if(!row || row.deleted || songOperation(row.operation)||row.state!=='completed')throw musicFailure('素材不可用',404);
  const spec=JSON.parse(row.payload) as StoredSpec;
  if(row.operation==='enhanced_upload')return {file:outputFile(id,'source'),mime:'audio/mpeg'};
  if(spec.multipart)return {file:spec.multipart.file,mime:spec.multipart.mime};
  if(row.operation==='voice_from_clip'&&spec.assetId) {
    const source=job(spec.assetId);
    if(source?.owner===row.owner&&['upload','enhanced_upload'].includes(source.operation))return sunoSourceFile(source.id);
  }
  throw musicFailure('原始录音未在本站保存',404);
}
function claimAction(row:Row,staleMs=600000) {
  const lease=randomUUID();
  const claimed=sqlite.prepare('UPDATE music_jobs SET lease=?,lease_until=? WHERE id=? AND lease_until<?').run(lease,Date.now()+staleMs,row.id,Date.now());
  if(!claimed.changes)throw musicFailure('任务正在处理，请刷新后重试',409);
  return {lease,release:()=>sqlite.prepare('UPDATE music_jobs SET lease=NULL,lease_until=0 WHERE id=? AND lease=?').run(row.id,lease)};
}
export async function cancelMusicUpload(id:string,owner:MusicOwner) {
  getMusicTask(id,owner);
  const row=job(id)!;
  if(row.provider!==SUNO_CHANNEL_TYPE||row.operation!=='enhanced_upload')throw musicFailure('该订单不是强化上传');
  if(row.state==='cancelled')return getMusicTask(id,owner);
  const action=claimAction(row);
  try {
    const current=job(id)!;
    if(current.state==='cancelled')return getMusicTask(id,owner);
    if(current.state==='queued'&&!current.upstream_id) {
      finishMusic(current,'cancelled','已在发送前取消');
    } else {
      const r=readReceipt(current);
      if(current.state!=='accepted'||r?.kind!=='enhanced'||r.status!=='queued') throw musicFailure('仅排队中的强化上传可取消',409);
      await cancelSunoUpload(activeChannel(current),r.id);
      persistReceipt({...current,lease:action.lease},{...r,status:'cancelled'});
      finishMusic(current,'cancelled','上游已确认取消');
    }
    return getMusicTask(id,owner);
  } catch(error) {
    if(error instanceof SunoError) {
      const current=job(id)!;
      if(current.upstream_id&&!finalStates.has(current.state))holdMusic(current,error.message,'query');
      throw musicFailure(publicError(error.message,[current.upstream_id])!,409);
    }
    throw error;
  } finally {action.release();}
}
export async function removeMusicVoice(id:string,owner:MusicOwner) {
  getMusicTask(id,owner);
  const row=job(id)!;
  if(row.provider!==SUNO_CHANNEL_TYPE||!voiceOperation(row.operation)||row.state!=='completed')throw musicFailure('音色不存在或未就绪',404);
  if(row.deleted===1)return getMusicTask(id,owner);
  const action=claimAction(row);
  try {
    const current=job(id)!;
    if(current.deleted===1)return getMusicTask(id,owner);
    const receipt=readReceipt(current);
    if(receipt?.kind!=='voice')throw musicFailure('音色回执缺失',409);
    const channel=activeChannel(current);
    const sameProfile="provider=? AND channel_id=? AND credential_hash=? AND upstream_id=? AND owner=? AND operation IN ('voice','enhanced_voice','voice_from_clip')";
    const profile=[SUNO_CHANNEL_TYPE,current.channel_id,current.credential_hash,receipt.id,current.owner];
    sqlite.prepare('UPDATE music_jobs SET deleted=2 WHERE deleted<>1 AND '+sameProfile).run(...profile);
    await deleteSunoVoice(channel,receipt.id);
    const related=sqlite.prepare("SELECT payload FROM music_jobs WHERE "+sameProfile).all(...profile) as {payload:string}[];
    const files=related.flatMap(record=>{const file=(JSON.parse(record.payload) as StoredSpec).multipart?.file;return file?[file]:[];});
    for(const file of new Set(files))await fs.rm(file,{force:true});
    sqlite.transaction(()=>{
      // Reusing a clip can yield the same profile in more than one local order.
      sqlite.prepare('UPDATE music_jobs SET deleted=1 WHERE '+sameProfile).run(...profile);
    })();
    return getMusicTask(id,owner);
  } catch(error) {
    if(error instanceof SunoError)throw musicFailure(publicError(error.message,[row.upstream_id])!,502);
    throw error;
  } finally {action.release();}
}
export function listSunoAssets(owner:MusicOwner,kind:'song'|'voice') {
  return (sqlite.prepare(`SELECT j.id FROM music_jobs j JOIN contents c ON c.id=j.content_id WHERE j.owner=? AND
    j.provider=? AND j.deleted<>1 AND j.operation IN (${kind==='song'?"'upload','enhanced_upload'":"'voice','enhanced_voice','voice_from_clip'"}) ORDER BY j.rowid DESC LIMIT 100`)
    .all(ownerKey(owner),SUNO_CHANNEL_TYPE) as {id:string}[]).map(r=>getMusicTask(r.id,owner));
}
export function adminMusicDiagnostics(id:string) {
  const row=job(id);
  if(!row||row.provider!==SUNO_CHANNEL_TYPE)throw musicFailure('音乐订单不存在',404);
  const r=readReceipt(row);
  const results=tracks(id);
  const c=sqlite.prepare("SELECT json_extract(metadata, '$.reviewKind') AS kind FROM contents WHERE id=?").get(row.content_id) as {kind?:string}|undefined;
  return {id,allowsSupplement:r?.kind==='songs'&&!r.conflict&&results.length===1&&c?.kind==='partial',operation:row.operation,state:row.state,channelId:row.channel_id,submissionId:row.submission_key,
    upstreamId:row.upstream_id,relatedTaskId:r?.kind==='voice'?r.taskId:undefined,receiptKind:r?.kind,providerStatus:r&&r.kind!=='songs'?r.status:undefined,
    error:row.error,results:results.map(t=>({id:t.id,upstreamId:t.upstream_id,status:t.status,error:t.error,saved:Boolean(t.saved)}))};
}
export async function adminRecoverMusic(id:string,adminId:number,input:{upstreamId?:unknown;evidence?:unknown;songIds?:unknown}) {
  const row=job(id);
  if(!row||row.provider!==SUNO_CHANNEL_TYPE)throw musicFailure('音乐订单不存在',404);
  if(!['review','accepted','submitting'].includes(row.state))throw musicFailure('该订单无需恢复',409);
  const {upstreamId,evidence,songIds}=input;
  if(typeof evidence!=='string'||evidence.trim().length<6||evidence.length>1000)throw musicFailure('请填写原请求与回执的核对依据');
  const action=claimAction(row);
  try {
    const current=job(id)!;
    const contentRow=sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(current.content_id) as any;
    if(!contentRow)throw musicFailure('原订单记录不存在',404);
    const billing=JSON.parse(contentRow.metadata||'{}').billingStatus;
    if(finalStates.has(current.state)||['settled','refunded'].includes(billing))throw musicFailure('该订单已结束',409);
    const prior=readReceipt(current);
    const supplement=prior?.kind==='songs'&&!prior.conflict&&JSON.parse(contentRow.metadata||'{}').reviewKind==='partial'&&songIds!==undefined;
    if(current.upstream_id&&(upstreamId!==undefined||songIds!==undefined&&!supplement))throw musicFailure('订单已有回执，不允许更换原编号',409);
    let receipt:SunoReceipt|undefined;
    if(!current.upstream_id||supplement) {
      const channel=activeChannel(current);
      const op=current.operation;
      if(['cover','sing','voice_cover'].includes(op)) {
        if(!Array.isArray(songIds)||songIds.length<1||songIds.length>2||songIds.some(v=>!sunoId(v))||new Set(songIds).size!==songIds.length)throw musicFailure('请提供原单已核实的歌曲编号');
        const known=tracks(id).map(t=>t.upstream_id);
        if(supplement&&(!known.every(id=>songIds.includes(id))||songIds.length<=known.length))throw musicFailure('补充回执必须保留已登记的原歌曲，并提供新查到的原单结果',409);
        const ordered=[...known,...songIds.filter(id=>!known.includes(id))];
        const content=sqlite.prepare('SELECT model_id FROM contents WHERE id=?').get(row.content_id) as any;
        const songs=await querySunoSongs(channel,ordered,content.model_id);
        if(new Set(songs.map(song=>song.id)).size!==ordered.length)throw musicFailure('原凭据查不到全部歌曲',409);
        receipt={kind:'songs',songs:ordered.map(id=>songs.find(song=>song.id===id)!)};
      } else if(op==='upload')throw musicFailure('普通上传没有文档化的原素材查询，请通过原回执核对',409);
      else {
        if(!sunoId(upstreamId))throw musicFailure('请提供已核实的原回执编号');
        receipt=await readSunoReceipt(channel,op,upstreamId as string);
      }
    }
    sqlite.transaction(()=>{
      if(receipt)persistReceipt({...current,lease:action.lease},receipt);
      sqlite.prepare("UPDATE music_jobs SET state='accepted',next_poll=0 WHERE id=?").run(id);
      sqlite.prepare('INSERT INTO music_recovery_audit(job_id,admin_id,evidence) VALUES(?,?,?)').run(id,adminId,publicGenerationError(evidence));
    }).immediate();
  } finally {action.release();}
}
