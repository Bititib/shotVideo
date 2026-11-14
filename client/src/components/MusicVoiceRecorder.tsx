import { useEffect, useRef, useState } from 'react';

const maxRecordingMs = 90_000;

async function wavFile(parts:Blob[],mime:string) {
  const source=await new Blob(parts,{type:mime}).arrayBuffer();
  const audio=new OfflineAudioContext(1,1,24000);
  const decoded=await audio.decodeAudioData(source);
  if(decoded.duration<6)throw new Error('请录制至少 6 秒的本人声音。');
  const samples=decoded.getChannelData(0);
  const buffer=new ArrayBuffer(44+samples.length*2);
  const view=new DataView(buffer);
  view.setUint32(0,0x52494646); // RIFF
  view.setUint32(4,buffer.byteLength-8,true);
  view.setUint32(8,0x57415645); // WAVE
  view.setUint32(12,0x666d7420); // fmt
  view.setUint32(16,16,true);
  view.setUint16(20,1,true);
  view.setUint16(22,1,true);
  view.setUint32(24,decoded.sampleRate,true);
  view.setUint32(28,decoded.sampleRate*2,true);
  view.setUint16(32,2,true);
  view.setUint16(34,16,true);
  view.setUint32(36,0x64617461); // data
  view.setUint32(40,samples.length*2,true);
  samples.forEach((sample,index)=>view.setInt16(44+index*2,Math.round(Math.max(-1,Math.min(1,sample))*32767),true));
  return new File([buffer],'本人录音.wav',{type:'audio/wav'});
}

export default function MusicVoiceRecorder({onFile,onBusy}:{onFile:(file:File)=>void;onBusy:(busy:boolean)=>void}) {
  const [phase,setPhase]=useState<'idle'|'starting'|'recording'|'encoding'>('idle');
  const [error,setError]=useState('');
  const session=useRef<{recorder:MediaRecorder;timer:ReturnType<typeof setTimeout>}|null>(null);
  const mounted=useRef(false);
  useEffect(()=>{
    mounted.current=true;
    return ()=>{
      mounted.current=false;
      const current=session.current;
      if(current) {
        clearTimeout(current.timer);
        current.recorder.onstop=null;
        if(current.recorder.state!=='inactive')current.recorder.stop();
        current.recorder.stream.getTracks().forEach(track=>track.stop());
      }
    };
  },[]);
  if(typeof MediaRecorder==='undefined'||typeof OfflineAudioContext==='undefined'||!navigator.mediaDevices?.getUserMedia)return null;
  async function start() {
    setError('');setPhase('starting');onBusy(true);
    let stream:MediaStream|undefined;
    try{
      stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1},video:false});
      if(!mounted.current){stream.getTracks().forEach(track=>track.stop());return;}
      const recorder=new MediaRecorder(stream);
      const parts:Blob[]=[];
      recorder.ondataavailable=event=>{if(event.data.size)parts.push(event.data);};
      recorder.onerror=()=>{setError('录音中断，请重新录制或上传文件。');};
      recorder.onstop=async()=>{
        if(session.current)clearTimeout(session.current.timer);
        session.current=null;
        recorder.stream.getTracks().forEach(track=>track.stop());
        if(!mounted.current)return;
        setPhase('encoding');
        try{
          const file=await wavFile(parts,recorder.mimeType);
          if(mounted.current)onFile(file);
        }catch(error){if(mounted.current)setError((error as Error).message||'无法读取录音，请上传音频文件。');}
        finally{if(mounted.current){setPhase('idle');onBusy(false);}}
      };
      recorder.start();
      session.current={recorder,timer:setTimeout(()=>{if(recorder.state==='recording')recorder.stop();},maxRecordingMs)};
      setPhase('recording');
    }catch{
      stream?.getTracks().forEach(track=>track.stop());
      if(mounted.current){setError('无法打开麦克风，请检查浏览器权限或上传音频文件。');setPhase('idle');onBusy(false);}
    }
  }
  return <div className="space-y-2">
    <button type="button" className="rounded-xl border border-white/10 px-3 py-2 text-sm disabled:opacity-50"
      disabled={phase==='starting'||phase==='encoding'} onClick={()=>phase==='recording'?session.current?.recorder.stop():void start()}>
      {phase==='recording'?'结束录音':phase==='starting'?'正在打开麦克风…':phase==='encoding'?'正在保存录音…':'录制本人声音'}
    </button>
    {phase==='recording'&&<p role="status">正在录音。录制 6–90 秒。</p>}
    {error&&<p role="alert" className="text-amber-200">{error}</p>}
  </div>;
}
