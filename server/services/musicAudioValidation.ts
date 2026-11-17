import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';

const exec = promisify(execFile);
/** Validate local output before marking it saved. Never follows network media URLs. */
export async function validateMusicAudioFile(file:string) {
  const size=(await fs.stat(file)).size;
  if(!size)throw new Error('音乐成品校验失败：文件为空');
  let stage='音轨与时长探测';
  try {
    const {stdout}=await exec('ffprobe',['-v','error','-protocol_whitelist','file,pipe','-select_streams','a',
      '-show_entries','stream=codec_name,sample_rate,channels:format=duration','-of','json',file],
      {timeout:30000,maxBuffer:1024*1024,windowsHide:true});
    const info=JSON.parse(stdout),track=info.streams?.[0],duration=Number(info.format?.duration);
    if(track?.codec_name!=='mp3'||!Number.isFinite(duration)||duration<=0||!(Number(track.sample_rate)>0)||!(track.channels>0))
      throw new Error('缺少有效 MP3 音轨或正数时长');
    stage='完整解码';
    // A valid MP3 header alone does not establish that any audio samples exist.
    const decoded=await exec('ffmpeg',['-nostdin','-v','error','-xerror','-err_detect','explode','-protocol_whitelist','file,pipe',
      '-i',file,'-map','0:a:0','-progress','pipe:1','-f','null','-'],
      {timeout:120000,maxBuffer:1024*1024,windowsHide:true});
    const times=[...decoded.stdout.matchAll(/^out_time_us=(\d+)$/gm)].map(match=>Number(match[1]));
    if(!times.some(time=>time>0))throw new Error('解码后没有有效音频样本');
    return {size,duration,codec:track.codec_name,sampleRate:Number(track.sample_rate),channels:track.channels};
  } catch(error:any) {
    const detail=String(error.stderr||error.message||error.code).split(file).join('[音频文件]').slice(0,600);
    throw new Error('音乐成品校验失败（'+stage+'）：'+detail);
  }
}
