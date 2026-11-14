import { openAsBlob } from 'node:fs';
import { SUNO_BASE_URL, type MusicOperation } from '../../shared/sunoMusic.js';
import { diagnosticJson, transportDiagnostic, upstreamDiagnostic } from './upstreamDiagnostic.js';

export type SunoChannel = { id: number; baseUrl: string; apiKey: string };
export type SunoSong = { id: string; status: string; title?: string; error?: string };
export type SunoReceipt = { conflict?: string } & (
  | { kind: 'request'; id: string; status: string; songs: SunoSong[]; error?: string }
  | { kind: 'songs'; songs: SunoSong[] }
  | { kind: 'upload' | 'enhanced' | 'voice'; id: string; status: string; clip?: string; title?: string; audio?: string; error?: string; progress?: number; taskId?: string });
export const SUNO_SUBMIT_TIMEOUT = 310_000;
export class SunoError extends Error {
  constructor(message: string, readonly confirmedRejection = false, readonly retryMs = 0) { super(message); }
}
const object = (value: any) => value && typeof value === 'object' && !Array.isArray(value);
export function sunoId(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(value) ? value : undefined;
}
function numberId(value: unknown) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
}
const documentedReject = /^(?:INVALID_API_KEY|API_KEY_DISABLED|INSUFFICIENT_BALANCE|invalid_request_error|voice_deleted)$/;
const terminal = new Set(['completed','failed']);
export const sunoSongTerminal = (status: string) => terminal.has(status);

export function sunoBase(value: string) {
  if (value.trim().replace(/\/+$/, '') !== SUNO_BASE_URL) {
    throw Object.assign(new Error('音乐渠道地址必须为 ' + SUNO_BASE_URL), { status: 400 });
  }
  return SUNO_BASE_URL;
}

async function request(channel: SunoChannel, stage: string, endpoint: string, method = 'GET',
  body?: FormData | Record<string, unknown>, headers: Record<string,string> = {}) {
  const multipart = body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(sunoBase(channel.baseUrl) + endpoint, {
      method, redirect: 'error', signal: AbortSignal.timeout(stage.startsWith('提交') ? SUNO_SUBMIT_TIMEOUT : 25_000),
      headers: { Authorization: 'Bearer ' + channel.apiKey, ...(body && !multipart ? {'Content-Type':'application/json'} : {}), ...headers },
      body: multipart ? body : body ? JSON.stringify(body) : undefined,
    });
  } catch (error) { throw new SunoError(transportDiagnostic('Suno', stage, error, channel.apiKey)); }
  const data = await diagnosticJson('Suno', stage, response, channel.apiKey);
  const trace = response.headers.get('x-oneapi-request-id') || response.headers.get('x-request-id') || undefined;
  return { response, data, trace, channel, stage };
}
type Reply = Awaited<ReturnType<typeof request>>;
function responseError(r: Reply, message?: string, reject = false) {
  const retryAfter = r.response.headers.get('retry-after');
  const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : retryAfter ? Date.parse(retryAfter)-Date.now() : 0;
  return new SunoError(upstreamDiagnostic('Suno',r.stage,message ? {message} : r.data,r.channel.apiKey,r.response.status,r.trace),
    reject, Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
}
function checked(r: Reply, op?: MusicOperation) {
  const d = r.data;
  const envelopeError = object(d) && (d.success === false || object(d.error));
  if (r.response.ok && !envelopeError) return;
  const code = d?.error?.code ?? d?.error_code ?? d?.error?.type ?? d?.code;
  const reason = d?.error?.message ?? d?.message;
  // These are documented pre-acceptance errors. Gateways/non-JSON/ambiguous 5xx
  // must never be used as proof that a paid request was rejected.
  const declared = envelopeError && typeof reason === 'string' && reason.trim();
  const selectedVoice = op === 'sing' || op === 'voice_cover';
  const voiceManagement = op === 'voice' || op === 'enhanced_voice' || op === 'voice_from_clip';
  const confirmed = Boolean(op && declared && (
    [400,401,402,403,429].includes(r.response.status) ||
    documentedReject.test(String(code)) ||
    (selectedVoice && /^(?:model is required|voice not found(?::|$)|voice is not ready yet|voice_id is required)/i.test(reason)) ||
    (voiceManagement && /^(?:one of file_path|voice audio is required|Uploaded audio is too short|This audio matches an existing recording|audio file exceeds |source audio (?:not found|is invalid)|source_song_id is required)/i.test(reason))
  ));
  throw responseError(r, undefined, confirmed);
}
function songList(rows: unknown): SunoSong[] {
  if (!Array.isArray(rows)) return [];
  return rows.flatMap(row => {
    const id = sunoId(row?.song_id);
    return id ? [{ id, status: typeof row.status === 'string' ? row.status : '',
      title: typeof row.song_title === 'string' ? row.song_title : typeof row.title === 'string' ? row.title : undefined,
      error: typeof row.error_message === 'string' ? row.error_message : undefined }] : [];
  });
}
function errorText(r: Reply, value: unknown) {
  return typeof value === 'string' && value.trim() ? upstreamDiagnostic('Suno',r.stage,{message:value},r.channel.apiKey) : undefined;
}
function receipt(r: Reply, op: MusicOperation): SunoReceipt {
  const d = r.data, row = d?.data;
  const expectedEnvelope = op === 'upload' ? d?.success !== false
    : op === 'cover' || op === 'sing' || op === 'voice_cover' ? d?.code === 200 : d?.success === true;
  const conflict = r.response.ok && expectedEnvelope && !object(d?.error) ? undefined
    : responseError(r).message;
  // Persist valid business IDs even if other response fields are incomplete.
  if (op === 'generate') {
    const id = sunoId(row?.request_id);
    if (id) return { kind:'request',conflict,id,status:String(row.status || ''),songs:songList(row.tasks).map(song=>({...song,error:errorText(r,song.error)})),error:errorText(r,row.error_message) };
  } else if (op === 'upload') {
    const id = sunoId(d?.clip_id);
    if (id) return {kind:'upload',conflict,id,clip:id,status:String(d.status || ''),title:d.title,audio:d.audio_url,error:errorText(r,d.error_message)};
  } else if (op === 'enhanced_upload') {
    const task = row?.task ?? row;
    const id = numberId(task?.task_id);
    if (id) return {kind:'enhanced',conflict,id,status:String(task.status || ''),clip:sunoId(task.song_id),title:task.title,audio:task.audio_url,
      progress:task.progress?.percent,error:errorText(r,task.error_message)};
  } else if (op === 'voice' || op === 'enhanced_voice' || op === 'voice_from_clip') {
    const id = sunoId(row?.voice_id);
    if (id?.startsWith('vp_')) return {kind:'voice',conflict,id,status:String(row.status || ''),clip:sunoId(row.clip_id ?? row.song_id),title:row.title,
      progress:row.progress_percent,taskId:numberId(row.task_id),error:errorText(r,row.error_message)};
  } else {
    const songs = songList(row?.clips);
    if (songs.length) {
      if ((op === 'sing' || op === 'voice_cover') && row.resolved_scene !== (op === 'sing' ? 'sing' : 'cover')) {
        // The IDs are still evidence of acceptance. Do not regenerate or settle automatically.
        return {kind:'songs',conflict:conflict||'上游受理的生成场景与请求不一致',songs:songs.map(song=>({...song,status:'scene_conflict'}))};
      }
      return {kind:'songs',conflict,songs:songs.map(song=>({...song,error:errorText(r,song.error)}))};
    }
  }
  checked(r, r.stage.startsWith('提交') ? op : undefined);
  throw responseError(r,'响应缺少该操作的有效受理编号或结果');
}
export type SunoSubmission = { operation: MusicOperation; endpoint: string; request: Record<string, any>; multipart?: { file: string; name: string; mime: string } };

export async function submitSuno(channel: SunoChannel, spec: SunoSubmission, key: string, beforeSend: () => void) {
  const {operation, endpoint, request: payload, multipart} = spec;
  let body: FormData | Record<string,any> = payload;
  if (multipart) {
    const form = new FormData();
    const file = await openAsBlob(multipart.file,{type:multipart.mime});
    form.append('file',file,multipart.name);
    for (const [k,v] of Object.entries(payload)) form.append(k,String(v));
    if (operation === 'voice' || operation === 'enhanced_voice') form.append('client_request_id',key);
    body=form;
  } else if (operation === 'voice_from_clip') body={...payload,client_request_id:key};
  beforeSend();
  const headers: Record<string,string> = {};
  if (operation === 'generate') headers['Idempotency-Key']=key;
  if (operation === 'sing' || operation === 'voice_cover') headers['X-Create-Ui-Client-Request-Id']=key;
  return receipt(await request(channel,'提交 '+operation,endpoint,'POST',body,headers),operation);
}
export async function readSunoReceipt(channel:SunoChannel, op:MusicOperation, id:string) {
  const e=encodeURIComponent(id);
  const endpoint = op==='generate' ? '/api/music/requests/'+e :
    op==='enhanced_upload' ? '/api/music/enhanced-upload/'+e : '/api/music/voice-profile/'+e;
  const result=receipt(await request(channel,'查询 '+op,endpoint),op);
  if (result.kind==='songs' || result.id!==id) throw new SunoError('上游回执编号不一致，需要核对原任务');
  return result;
}
export async function findSunoEnhancedVoice(channel:SunoChannel,tracking:string) {
  const r=await request(channel,'查询强化音色列表','/api/music/voice-profile/list');
  checked(r);
  const items=r.data?.data?.items;
  if(r.data?.success!==true||!Array.isArray(items))throw responseError(r,'音色列表格式无效');
  const ids=[...new Set(items.flatMap(item=>{
    const id=sunoId(item?.voice_id);
    return item?.enhanced===true&&item.client_request_id===tracking&&id?.startsWith('vp_')?[id]:[];
  }))];
  if(ids.length>1)throw responseError(r,'原请求对应多条音色，需要核对');
  return ids[0]?readSunoReceipt(channel,'enhanced_voice',ids[0]):undefined;
}
export async function querySunoSongs(channel:SunoChannel,ids:string[],model:string) {
  const r=await request(channel,'查询歌曲','/api/music/query','POST',{song_ids:ids.join(','),model});
  checked(r);
  if (!Array.isArray(r.data)) throw responseError(r,'歌曲查询返回了无法识别的响应结构');
  return songList(r.data).filter(song=>ids.includes(song.id)).map(song=>({...song,error:errorText(r,song.error)}));
}
export async function cancelSunoUpload(channel:SunoChannel,id:string) {
  const r=await request(channel,'取消强化上传','/api/music/enhanced-upload/'+encodeURIComponent(id)+'/cancel','POST');
  checked(r);
  if (r.data?.success!==true || numberId(r.data.data?.task_id)!==id || r.data.data?.status!=='cancelled') {
    throw responseError(r,'未收到该任务的取消确认');
  }
}
export async function deleteSunoVoice(channel:SunoChannel,id:string) {
  const r=await request(channel,'删除音色','/api/music/voice-profile/delete','POST',{voice_id:id});
  checked(r);
  if (r.data?.success!==true || r.data.data?.voice_id!==id || r.data.data?.status!=='deleted') throw responseError(r,'未收到该音色的删除确认');
}
export async function getSunoBalance(channel:SunoChannel) {
  const r=await request(channel,'查询余额','/api/user/balance');
  checked(r);
  const amount=r.data?.data?.balance?.effective_amount;
  if (r.data?.success!==true || typeof amount!=='number' || !Number.isFinite(amount)) throw responseError(r,'余额响应格式无效');
  return amount;
}
export async function getSunoModels(channel:SunoChannel) {
  const r=await request(channel,'查询模型','/v1/models');
  checked(r);
  if (!Array.isArray(r.data?.data)) throw responseError(r,'模型目录格式无效');
  return (r.data.data as unknown[]).map(row=>sunoId((row as {id?:unknown})?.id)).filter((id):id is string=>typeof id==='string');
}
export async function fetchSunoAudio(channel:SunoChannel,id:string,source?:string) {
  let url = source ? new URL(source) : new URL('/api/music/download?song_id='+encodeURIComponent(id)+'&kind=mp3',sunoBase(channel.baseUrl));
  const signal=AbortSignal.timeout(40_000);
  const sendKey=!source;
  for (let hop=0;hop<5;hop++) {
    // Only platform media or the platform's documented CDN storage destinations.
    if (url.protocol!=='https:' || url.port || url.username || url.password ||
      !/^(?:[a-z0-9-]+\.)*(?:suno-api\.io|code-go\.com|suno\.ai)$|^suno-api-(?:[a-z0-9-]+-)*\d+\.cos\.[a-z0-9-]+\.myqcloud\.com$/i.test(url.hostname)) {
      throw new SunoError('成品地址不在允许的上游媒体域名内，保留原歌曲待核对');
    }
    const response=await fetch(url,{redirect:'manual',signal,headers:sendKey&&hop===0?{Authorization:'Bearer '+channel.apiKey}:{}});
    if ([301,302,303,307,308].includes(response.status)) {
      const location=response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new SunoError('成品下载重定向缺少地址');
      url=new URL(location,url);
      continue;
    }
    return response;
  }
  throw new SunoError('成品下载重定向次数超限');
}


/** Recover a voice generation only with the exact persisted request identifier. */
export async function findSunoVoiceSongs(channel:SunoChannel,tracking:string,model:string,source?:string) {
  const found=new Map<number,SunoSong>();
  const deadline=Date.now()+45_000;
  for(let page=1;page<=3;page++) {
    const history=await request(channel,'查询翻唱历史','/api/music/songs?p='+page+'&page_size=20');
    checked(history);
    const items=history.data?.data?.items;
    if(history.data?.success!==true||!Array.isArray(items))throw responseError(history,'歌曲历史响应结构无效');
    for(const item of items) {
      if(Date.now()>deadline)return [];
      const id=sunoId(item?.song_id);
      if(!id||item.generation_type!=='voice_profile_cover')continue;
      const detail=await request(channel,'核对歌曲追踪号','/api/music/songs/'+encodeURIComponent(id));
      checked(detail);
      const data=detail.data?.data;
      const index=data?.client_request_index;
      if(detail.data?.success!==true||data?.song_id!==id||data?.client_request_id!==tracking||
        data.generation_type!=='voice_profile_cover'||data.model!==model||
        (data.parameters?.source_song_id||undefined)!==source||![0,1].includes(index))continue;
      if(found.has(index)&&found.get(index)!.id!==id)throw new SunoError('同一追踪号存在冲突的歌曲编号');
      const [song]=songList([data]);
      found.set(index,{...song,error:errorText(detail,song.error)});
    }
    if(found.size===2||items.length<20)break;
  }
  // A partial history cannot prove the count or terminal outcome of the order.
  return found.size===2?[...found.entries()].sort(([a],[b])=>a-b).map(([,song])=>song):[];
}
