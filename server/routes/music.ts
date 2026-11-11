import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { tierMiddleware, type TierRequest } from '../middleware/tier.js';
import { getEnabledPublicModels } from '../services/modelCatalogService.js';
import { musicBinding } from '../services/musicModelRegistry.js';
import { createMusicTask, getMusicTask, listMusicTasks, musicFile, processMusicTask } from '../services/musicGenerationService.js';

const router=Router();
router.use(authMiddleware);
router.get('/models',tierMiddleware('music'),(req:TierRequest,res,next)=>{
  try {res.json(getEnabledPublicModels('music',req.userId).filter(m=>req.userRole==='admin'||req.userRole==='super_admin'||req.availableModels?.some(a=>a.modelId===m.modelId))
    .map(m=>({id:m.modelId,name:m.displayName,cost:musicBinding(m.modelId,req.userId).quote.cost})));}catch(e){next(e);}
});
router.post('/',tierMiddleware('music'),(req:TierRequest,res,next)=>{
  try {
    if(req.userRole!=='admin'&&req.userRole!=='super_admin'&&!req.availableModels?.some(m=>m.modelId===req.body?.model))return res.status(403).json({error:'当前等级无法使用此模型'});
    const task=createMusicTask(req.body,{userId:req.userId});res.status(202).json(task);void processMusicTask(task.id);
  }catch(e){next(e);}
});
// Reading/downloading one's already-paid tasks remains available after permission changes.
router.get('/',(req:AuthRequest,res,next)=>{try{res.json(listMusicTasks({userId:req.userId}));}catch(e){next(e);}});
router.get('/:id/file',(req:AuthRequest,res,next)=>{try{res.download(musicFile(req.params.id,{userId:req.userId}),'music.mp3');}catch(e){next(e);}});
router.get('/:id',(req:AuthRequest,res,next)=>{try{res.json(getMusicTask(req.params.id,{userId:req.userId}));}catch(e){next(e);}});
export default router;
