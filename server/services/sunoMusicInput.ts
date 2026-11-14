import { createHash } from 'node:crypto';
import type { SunoSubmission } from './sunoMusicAdapter.js';
import { MUSIC_OPERATIONS, type MusicOperation } from '../../shared/sunoMusic.js';

export const musicFailure=(message:string,status=400)=>Object.assign(new Error(message),{status});
export const musicHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const musicLocalId=(id:unknown):id is string=>typeof id==='string' && /^[a-f0-9-]{36}$/.test(id);
function stringField(value:unknown,label:string,max:number,required=false) {
  if (value===undefined&&!required) return undefined;
  if (typeof value!=='string' || value.length>max || required&&!value.trim()) throw musicFailure(label+'格式无效或超过 '+max+' 字');
  return value;
}
function booleanField(value:unknown,name:string) {
  if(value===undefined)return false;
  if(typeof value!=='boolean')throw musicFailure(name+' 必须为布尔值');
  return value;
}
function numberField(value:unknown,name:string,min:number,max:number,integer=false) {
  if(value===undefined)return undefined;
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||value>max||integer&&!Number.isInteger(value)) throw musicFailure(name+' 取值应在 '+min+' 到 '+max+' 之间');
  return value;
}

export function parseSunoInput(input:any, hasFile:boolean) {
  if (!input || typeof input!=='object' || Array.isArray(input)) throw musicFailure('请求必须是对象');
  const op:MusicOperation=input.operation===undefined?'generate':input.operation;
  if(!MUSIC_OPERATIONS.includes(op))throw musicFailure('未知音乐操作');
  const allowed=['operation','model','client_request_id','expected_cost'];
  const operationFields:Record<MusicOperation,string[]>={
    upload:['title','rights_confirmed'], enhanced_upload:['title','rights_confirmed'],
    voice:['title','self_voice_confirmed','source_kind'],enhanced_voice:['title','self_voice_confirmed','rights_confirmed','source_kind'],
    voice_from_clip:['title','self_voice_confirmed','asset_id'],
    generate:['prompt','lyrics','title','mode','vocal','tags','max_mode','variety','style_weight','weirdness_constraint','negative_tags','custom'],
    cover:['asset_id','prompt','lyrics','title','mode','vocal','tags','max_mode','variety','style_weight','weirdness_constraint','negative_tags','audio_weight','custom'],
    sing:['voice_id','lyrics','title','tags','style_requirements','max_mode','variety','style_weight','weirdness_constraint','negative_tags','audio_weight','duration'],
    voice_cover:['asset_id','voice_id','lyrics','title','tags','style_requirements','cover_requirements','max_mode','variety','style_weight','weirdness_constraint','negative_tags','audio_weight','duration'],
  };
  if(Object.keys(input).some(k=>!allowed.includes(k)&&!operationFields[op].includes(k)))throw musicFailure('存在此操作不支持的音乐参数');
  const fileRequired=['upload','enhanced_upload','voice','enhanced_voice'].includes(op);
  if(fileRequired!==hasFile)throw musicFailure(fileRequired?'请上传一个音频文件':'此操作请使用已保存的素材编号');
  if(typeof input.model!=='string'||!input.model.trim())throw musicFailure('请选择音乐模型');
  if(typeof input.client_request_id!=='string'||!/^[A-Za-z0-9_-]{8,64}$/.test(input.client_request_id))throw musicFailure('请提供 8–64 位 client_request_id');
  if(input.expected_cost!==undefined && (typeof input.expected_cost!=='number'||!Number.isFinite(input.expected_cost)||input.expected_cost<0))throw musicFailure('expected_cost 必须是非负数字');
  const needsAsset=['cover','voice_cover','voice_from_clip'].includes(op);
  const needsVoice=['sing','voice_cover'].includes(op);
  if(needsAsset&&!musicLocalId(input.asset_id))throw musicFailure('请选择已就绪的歌曲素材');
  if(needsVoice&&!musicLocalId(input.voice_id))throw musicFailure('请选择已就绪的本人音色');
  if(['upload','enhanced_upload','enhanced_voice'].includes(op)&&input.rights_confirmed!==true)throw musicFailure('请确认已取得相应音频及词曲的使用权限');
  if(['voice','enhanced_voice','voice_from_clip'].includes(op)&&input.self_voice_confirmed!==true)throw musicFailure('请确认上传的是本人有权使用的声音');
  if(input.source_kind!==undefined&&!['upload','record'].includes(input.source_kind))throw musicFailure('音色样本来源必须是 upload 或 record');
  const sourceKind=input.source_kind as 'upload'|'record'|undefined;
  const title=stringField(input.title,'标题',100);
  const prompt=stringField(input.prompt,'音乐描述',3000);
  const lyrics=stringField(input.lyrics,'歌词',5000);
  if(input.tags!==undefined&&(!Array.isArray(input.tags)||input.tags.some((tag:unknown)=>typeof tag!=='string'||!tag.trim())))throw musicFailure('风格标签必须是非空字符串列表');
  const style=stringField(input.style_requirements??input.tags?.join(', '),'风格',1000);
  if(input.style_requirements!==undefined&&input.tags!==undefined)throw musicFailure('风格描述与风格标签请选择一种填写方式');
  const negative=stringField(input.negative_tags,'排除风格',1000);
  const coverRequirements=stringField(input.cover_requirements,'翻唱要求',3000);
  if(input.mode!==undefined&&!['song','instrumental'].includes(input.mode))throw musicFailure('音乐模式无效');
  if(input.vocal!==undefined&&!['auto','m','f'].includes(input.vocal))throw musicFailure('人声选项无效');
  const instrumental=input.mode==='instrumental';
  const vocal=input.vocal==='auto'?undefined:input.vocal;
  if(instrumental&&(lyrics||vocal))throw musicFailure('纯音乐不能同时指定歌词或演唱声音');
  const maxMode=booleanField(input.max_mode,'max_mode');
  const custom=input.custom===undefined?Boolean(lyrics||style||title||vocal||negative||input.style_weight!==undefined||input.weirdness_constraint!==undefined):booleanField(input.custom,'custom');
  const variety=numberField(input.variety,'variety',0,4,true);
  const styleWeight=numberField(input.style_weight,'style_weight',0,1);
  const weirdness=numberField(input.weirdness_constraint,'weirdness_constraint',0,1);
  const audioWeight=numberField(input.audio_weight,'audio_weight',0,1);
  const duration=numberField(input.duration,'duration',1,480,true);
  if(op==='generate'&&!custom&&(lyrics||style||title||vocal||negative||styleWeight!==undefined||weirdness!==undefined))throw musicFailure('灵感生成请使用音乐描述，指定歌词、风格或人声请使用专业模式');
  if(op==='generate'&&custom&&(!style?.trim()||prompt?.trim()))throw musicFailure('专业生成须填写风格，音乐描述请留空');
  if(op==='generate'&&!custom&&!prompt?.trim())throw musicFailure('请输入音乐描述');
  if(op==='cover'&&!custom&&lyrics)throw musicFailure('指定翻唱歌词时请选择专业模式');
  if(op==='cover'&&custom&&(!style?.trim()||!title?.trim()||prompt?.trim()))throw musicFailure('专业翻唱须填写风格和标题，创作描述请留空');
  return {op,model:input.model as string,key:input.client_request_id as string,expected:input.expected_cost as number|undefined,
    title,prompt,lyrics,style,negative,coverRequirements,instrumental,vocal,maxMode,custom,variety,styleWeight,weirdness,audioWeight,duration,
    sourceKind,assetId:input.asset_id as string|undefined,voiceId:input.voice_id as string|undefined,
    rights:input.rights_confirmed===true,selfVoice:input.self_voice_confirmed===true};
}

type Source={clip:string; audio?:string;title?:string};
export function sunoSubmission(i:ReturnType<typeof parseSunoInput>, source?:Source,voice?:{id:string}, file?:SunoSubmission['multipart']):SunoSubmission {
  const operation=i.op;
  const extras={max_mode:i.maxMode,variety:i.variety};
  if(operation==='generate') {
    const request=i.custom?{model:i.model,lyrics:i.lyrics,style_tags:i.style,song_title:i.title,instrumental:i.instrumental,
      negative_tags:i.negative,vocal_gender:i.vocal,style_weight:i.styleWeight,weirdness_constraint:i.weirdness}:
      {model:i.model,description:i.prompt,instrumental:i.instrumental};
    return {operation,endpoint:'/api/music/create'+(i.custom?'/custom':''),request:{...request,...extras,accept_mode:'async'}};
  }
  if(operation==='cover'&&source) {
    return {operation,endpoint:'/api/music/generate-from-source',request:{model:i.model,sourceClipId:source.clip,
      sourceAudioUrl:source.audio,sourceTitle:source.title,prompt:i.custom?i.lyrics:i.prompt,customMode:i.custom,style:i.style,title:i.title,
      negativeTags:i.negative,instrumental:i.instrumental,vocalGender:i.vocal,styleWeight:i.styleWeight,weirdnessConstraint:i.weirdness,
      audio_weight:i.audioWeight,waitAudio:false,...extras}};
  }
  if((operation==='sing'||operation==='voice_cover')&&voice) {
    return {operation,endpoint:'/api/music/voice-profile/cover',request:{model:i.model,voice_id:voice.id,song_clip_id:source?.clip,
      lyrics:i.lyrics,title:i.title,style_requirements:i.style,cover_requirements:i.coverRequirements,negative_tags:i.negative,
      audio_weight:i.audioWeight,style_weight:i.styleWeight,weirdness_constraint:i.weirdness,duration:i.duration,...extras}};
  }
  if(operation==='voice_from_clip'&&source) return {operation,endpoint:'/api/music/voice-profile/create-from-clip',request:{source_song_id:source.clip,title:i.title}};
  if(!file)throw musicFailure('音频素材或音色未就绪');
  if(operation==='upload')return {operation,endpoint:'/api/music/upload-source',request:{model:i.model,file_name:file.name},multipart:file};
  if(operation==='enhanced_upload')return {operation,endpoint:'/api/music/enhanced-upload',request:i.title?{title:i.title}:{},multipart:file};
  return {operation,endpoint:'/api/music/voice-profile/create',request:{...(i.title?{title:i.title}:{}),source_kind:i.sourceKind??'upload',
    ...(operation==='enhanced_voice'?{enhanced:true}:{})},multipart:file};
}
