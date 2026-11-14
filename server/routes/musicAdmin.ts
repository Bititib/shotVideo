import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { adminMiddleware } from '../middleware/admin.js';
import { ensureMusicJobs, processMusicTask } from '../services/musicGenerationService.js';
import { adminMusicDiagnostics, adminRecoverMusic } from '../services/sunoMusicJobs.js';

const router=Router();
router.use(authMiddleware,adminMiddleware);
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
