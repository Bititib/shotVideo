import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { ensureMusicJobs, processMusicTask } from '../services/musicGenerationService.js';
import { adminMusicDiagnostics, adminRecoverMusic, adminMusicSources, adminMusicSourceFile, adminMusicResultFile } from '../services/sunoMusicJobs.js';

const router=Router();
router.use(authMiddleware,adminMiddleware);
router.use((_req,res,next)=>{res.setHeader('Cache-Control','private, no-store');next();});
router.get('/:id/results/:resultId/file',(req,res,next)=>{
  ensureMusicJobs();
  void adminMusicResultFile(req.params.id,req.params.resultId).then(file=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.type('audio/mpeg').sendFile(file,{cacheControl:false},error=>{if(error)next(error);});
  }).catch(next);
});
router.get('/:id/sources',(req,res,next)=>{
  ensureMusicJobs();
  void adminMusicSources(req.params.id).then(sources=>res.json(sources)).catch(next);
});
router.get('/:id/sources/:sourceId/file',(req,res,next)=>{
  ensureMusicJobs();
  void adminMusicSourceFile(req.params.id,req.params.sourceId).then(source=>{
    res.setHeader('X-Content-Type-Options','nosniff');
    res.type(source.mime).sendFile(source.file,{cacheControl:false},error=>{if(error)next(error);});
  }).catch(next);
});
router.get('/:id', (req,res,next)=>{
  try{ensureMusicJobs();res.setHeader('Cache-Control','no-store').json(adminMusicDiagnostics(req.params.id));}catch(e){next(e);}
});
router.post('/:id/recover',(req:AuthRequest,res,next)=>{
  ensureMusicJobs();
  void adminRecoverMusic(req.params.id,req.userId!,req.body||{}).then(()=>{
    res.status(202).json(adminMusicDiagnostics(req.params.id));
    void processMusicTask(req.params.id);
  }).catch(next);
});
export default router;
