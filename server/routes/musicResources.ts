import { Router, type Request, type Response, type RequestHandler } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { createMusicTask, ensureMusicJobs, getMusicTask, processMusicTask, type MusicOwner } from '../services/musicGenerationService.js';
import { cancelMusicUpload, listSunoAssets, musicPrivateDir, removeMusicVoice, sunoSourceFile } from '../services/sunoMusicJobs.js';
import { probeAudioBufferDuration } from '../services/videoDurationProbe.js';
import { detectedMediaMime } from '../services/privateMediaStore.js';
import { musicFailure } from '../services/sunoMusicInput.js';

type WebsitePermission=(req:Request,model:unknown)=>void;
const upload=multer({storage:multer.diskStorage({
  destination(_req,_file,done){const dir=path.join(musicPrivateDir(),'sources');void fs.mkdir(dir,{recursive:true}).then(()=>done(null,dir),error=>done(error,dir));},
  filename(_req,_file,done){done(null,randomUUID());},
}),limits:{files:1,fileSize:40*1024*1024,fields:1,fieldSize:16*1024,parts:3}});
export const musicMultipart:RequestHandler=(req,res,next)=>{
  upload.single('file')(req,res,error=>{
    if(error)return next(musicFailure(error.code==='LIMIT_FILE_SIZE'?'音乐素材不能超过 40 MB':'上传需要一个音频文件和一个 options 字段'));
    next();
  });
};

const TYPES:Record<string,string>={'.wav':'audio/wav','.mp3':'audio/mpeg','.m4a':'audio/mp4','.aac':'audio/aac','.ogg':'audio/ogg','.flac':'audio/flac'};
function assertOperation(input:any,kind:'asset'|'voice',file:boolean) {
  const allowed=kind==='asset'?['upload','enhanced_upload']:file?['voice','enhanced_voice']:['voice_from_clip'];
  if(!allowed.includes(input?.operation))throw musicFailure('请指定此入口支持的素材操作');
}
export async function createMusicResource(req:Request,res:Response,owner:MusicOwner,kind:'asset'|'voice',permission?:WebsitePermission) {
  let keep=false;
  try {
    const file=req.file;
    let input=req.body;
    if(req.is('multipart/form-data')) {
      if(!file)throw musicFailure('请选择一个音频文件');
      try { input=JSON.parse(req.body.options); } catch { throw musicFailure('options 必须是 JSON 对象'); }
    }
    assertOperation(input,kind,Boolean(file));
    permission?.(req,input.model);
    let prepared;
    if(file) {
      const limit=kind==='voice'?10:40;
      if(!file.size||file.size>limit*1024*1024)throw musicFailure('音频不能为空或超过 '+limit+' MB');
      const bytes=await fs.readFile(file.path);
      const clean=file.originalname.split(/[\\/]/).pop()||'audio';
      const extension=path.extname(clean).toLowerCase(),mime=TYPES[extension];
      const recognized=detectedMediaMime(bytes,mime||'');
      const rawFlac=extension==='.flac'&&bytes.subarray(0,4).toString()==='fLaC';
      const rawAac=extension==='.aac'&&bytes[0]===255&&(bytes[1]&246)===240;
      if(!mime||recognized!==mime&&!rawFlac&&!rawAac)throw musicFailure('请选择有效的 MP3、WAV、M4A、AAC、FLAC 或 OGG 音频');
      let seconds:number;
      try {seconds=await probeAudioBufferDuration(bytes);}catch(error){ throw musicFailure((error as Error).message);}
      if(kind==='voice'&&seconds<6)throw musicFailure('本人音色样本至少 6 秒');
      await fs.chmod(file.path,0o600);
      prepared={path:file.path,name:clean.slice(0,150-extension.length)+ (clean.length>150?extension:''),mime,digest:createHash('sha256').update(bytes).digest('hex')};
    }
    const {task,retainedFile}=createMusicTask(input,owner,prepared);
    keep=retainedFile;
    res.status(202).json(task);void processMusicTask(task.id);
  } finally {if(req.file&&!keep)await fs.rm(req.file.path,{force:true}).catch(()=>{});}
}
export const requireMusicModel:WebsitePermission=(req,model)=>{
  const r=req as Request & {userRole?:string;availableModels?:{modelId:string}[]};
  if(!['admin','super_admin'].includes(r.userRole||'')&&!r.availableModels?.some(m=>m.modelId===model))throw musicFailure('当前等级无法使用此模型',403);
};
export function createMusicResourceRouter(ownerFor:(req:Request)=>MusicOwner,writeAuth:RequestHandler,permission?:WebsitePermission) {
  const router=Router();
  const ownerMiddleware:RequestHandler=(req,res,next)=>{
    try {res.locals.musicOwner=ownerFor(req);res.setHeader('Cache-Control','no-store');next();}catch(error){next(error);}
  };
  const owner=(res:Response)=>res.locals.musicOwner as MusicOwner;
  router.get('/assets',ownerMiddleware,(_req,res,next)=>{try{ensureMusicJobs();res.json(listSunoAssets(owner(res),'song'));}catch(e){next(e);}});
  router.get('/voices',ownerMiddleware,(_req,res,next)=>{try{ensureMusicJobs();res.json(listSunoAssets(owner(res),'voice'));}catch(e){next(e);}});
  router.post('/assets',writeAuth,ownerMiddleware,musicMultipart,(req,res,next)=>void createMusicResource(req,res,owner(res),'asset',permission).catch(next));
  router.post('/voices',writeAuth,ownerMiddleware,musicMultipart,(req,res,next)=>void createMusicResource(req,res,owner(res),'voice',permission).catch(next));
  router.get('/assets/:id/file',ownerMiddleware,(req,res,next)=>{
    try {
      const task=getMusicTask(req.params.id,owner(res));
      if(task.operation!=='upload'&&task.operation!=='enhanced_upload')throw musicFailure('音乐素材不存在',404);
      res.setHeader('X-Content-Type-Options','nosniff');
      const source=sunoSourceFile(task.id);
      res.type(source.mime).sendFile(source.file);
    }catch(e){next(e);}
  });
  router.get('/voices/:id/file',ownerMiddleware,(req,res,next)=>{
    try {
      const task=getMusicTask(req.params.id,owner(res));
      if(!task.voice_id)throw musicFailure('音色样本不存在',404);
      const source=sunoSourceFile(task.id);
      res.setHeader('X-Content-Type-Options','nosniff');
      res.type(source.mime).sendFile(source.file);
    }catch(e){next(e);}
  });
  router.post('/assets/:id/cancel',ownerMiddleware,(req,res,next)=>void cancelMusicUpload(req.params.id,owner(res)).then(task=>res.json(task)).catch(next));
  router.delete('/voices/:id',ownerMiddleware,(req,res,next)=>void removeMusicVoice(req.params.id,owner(res)).then(task=>res.json(task)).catch(next));
  return router;
}
