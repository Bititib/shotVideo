import { Router } from 'express';
import jwt from 'jsonwebtoken';
import path from 'node:path';
import { sqlite } from '../db/index.js';
import { env } from '../config/env.js';
import { authMiddleware, type AuthRequest } from '../middleware/auth.js';
import { createPrivateMediaStore } from '../services/privateMediaStore.js';
import { prepareVideoForDelivery, videoDeliveryContentType } from '../services/videoCompatibilityService.js';

const router=Router();
let store: ReturnType<typeof createPrivateMediaStore>;
export const privateMediaStore=()=>store??=createPrivateMediaStore(sqlite,path.resolve(process.env.MEDIA_STORAGE_DIR || 'data/private-media'));
export function mediaUser(req: AuthRequest): number | undefined {
  const bearer=req.headers.authorization?.replace(/^Bearer /,'');
  const cookie=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('media_session='))?.slice(14);
  try {const decoded=jwt.verify(bearer||cookie||'',env.JWT_SECRET) as {userId:number};
    const user=sqlite.prepare('SELECT is_active FROM users WHERE id=?').get(decoded.userId) as any;
    return user?.is_active ? decoded.userId : undefined;
  } catch {return undefined;}
}
router.post('/',authMiddleware,(req:AuthRequest,res,next)=>{
  try {
    const {dataUrl,filename}=req.body;
    if (typeof dataUrl!=='string'||dataUrl.length>57*1024*1024) {res.status(400).json({error:'素材超过上传限制'});return;}
    const match=/^data:([a-z0-9/+.-]+);base64,([a-zA-Z0-9+/\r\n]*={0,2})$/.exec(dataUrl);
    if(!match) {res.status(400).json({error:'素材格式无效'});return;}
    const media=privateMediaStore().put(req.userId!,Buffer.from(match[2],'base64'),match[1],String(filename||'素材'));
    res.status(201).json({id:media.id,url:`/api/media/${media.id}`,mime:media.mime,bytes:media.bytes});
  } catch(e) {res.status(400).json({error:(e as Error).message});}
});
router.post('/:id/link',authMiddleware,(req:AuthRequest,res)=>{
  const media=privateMediaStore().get(req.params.id);
  if(!media||media.user_id!==req.userId) {res.status(404).json({error:'素材不存在'});return;}
  const base=process.env.BACKEND_URL||`${req.protocol}://${req.get('host')}`;
  res.setHeader('Cache-Control','no-store');
  res.json({url:`${base.replace(/\/$/, '')}/api/media/${media.id}`,expiresIn:null});
});
router.get('/:id',async (req:AuthRequest,res)=>{
  const media=privateMediaStore().get(req.params.id);
  if(!media) {res.status(404).json({error:'素材不存在'});return;}
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Type',media.mime);
  res.setHeader('X-Content-Type-Options','nosniff');
  try {
    const source = privateMediaStore().filePath(media);
    const file = media.mime.startsWith('video/') ? await prepareVideoForDelivery(source) : source;
    if (media.mime.startsWith('video/')) res.type(videoDeliveryContentType(file));
    res.sendFile(file);
  } catch {
    res.status(502).json({ error: '视频兼容版准备失败，请稍后重试' });
  }
});
export default router;
