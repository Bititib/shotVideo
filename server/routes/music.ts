import { Router } from 'express';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { tierMiddleware, type TierRequest } from '../middleware/tier.js';
import { getEnabledPublicModels } from '../services/modelCatalogService.js';
import { musicBinding, musicPrices } from '../services/musicModelRegistry.js';
import { createMusicTask, getMusicTask, getMusicTaskByRequest, listMusicTasks, musicFile, processMusicTask } from '../services/musicGenerationService.js';
import { createMusicResourceRouter, requireMusicModel } from './musicResources.js';
import { songOperation } from '../../shared/sunoMusic.js';

const router=Router();
router.use(authMiddleware);
router.use(createMusicResourceRouter(req=>({userId:(req as AuthRequest).userId}),tierMiddleware('music'),requireMusicModel));
router.get('/models',tierMiddleware('music'),(req:TierRequest,res,next)=>{
  try {
    res.json(getEnabledPublicModels('music',req.userId).filter(m=>['admin','super_admin'].includes(req.userRole||'')||req.availableModels?.some(a=>a.modelId===m.modelId))
      .map(m=>{const binding=musicBinding(m.modelId,req.userId);return {id:m.modelId,name:m.displayName,cost:binding.quote.cost,prices:musicPrices(binding,req.userId)};}));
  }catch(e){next(e);}
});
router.post('/',tierMiddleware('music'),(req:TierRequest,res,next)=>{
  try {
    requireMusicModel(req,req.body?.model);
    if(req.body?.operation!==undefined&&!songOperation(req.body.operation))return res.status(400).json({error:'请通过素材或音色接口提交'});
    const {task}=createMusicTask(req.body,{userId:req.userId});res.status(202).json(task);void processMusicTask(task.id);
  }catch(e){next(e);}
});
router.get('/',(req:AuthRequest,res,next)=>{try{res.json(listMusicTasks({userId:req.userId}));}catch(e){next(e);}});
router.get('/:id/results/:resultId/file',(req:AuthRequest,res,next)=>{
  try{res.setHeader('Cache-Control','private, no-store');res.type('audio/mpeg').sendFile(musicFile(req.params.id,{userId:req.userId},req.params.resultId));}
  catch(e){next(e);}
});
router.get('/:id/file',(req:AuthRequest,res,next)=>{
  try{res.setHeader('Cache-Control','private, no-store');res.type('audio/mpeg').sendFile(musicFile(req.params.id,{userId:req.userId}));}
  catch(e){next(e);}
});
router.get('/by-request/:key',(req:AuthRequest,res,next)=>{try{res.json(getMusicTaskByRequest(req.params.key,{userId:req.userId}));}catch(e){next(e);}});
router.get('/:id',(req:AuthRequest,res,next)=>{try{res.json(getMusicTask(req.params.id,{userId:req.userId}));}catch(e){next(e);}});
export default router;
