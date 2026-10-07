import type { RequestHandler } from 'express';
import { mediaUser } from '../routes/media.js';
import { ownsUpload, ownsResultUrl, uploadPath, canReviewResultUrl, isPublicVideoResult } from '../services/uploadAccess.js';
import { validMediaSignature } from '../services/mediaSignature.js';

export const protectUploads: RequestHandler=(req,res,next)=>{
  const resource=uploadPath(req.originalUrl);
  if (resource && isPublicVideoResult(resource)) {
    res.setHeader('Cache-Control', 'no-store'); next(); return;
  }
  const owner=mediaUser(req);
  if(!resource||!(validMediaSignature(resource,req.query.expires,req.query.signature)||(owner&&(ownsUpload(owner,resource)||canReviewResultUrl(owner,resource))))) {res.status(404).json({error:'素材不存在或无权访问'});return;}
  res.setHeader('Cache-Control','private, no-store');next();
};

export const protectVideoSource: RequestHandler=(req,res,next)=>{
  const source=typeof req.query.url==='string'?req.query.url:'';
  if (isPublicVideoResult(source)) {
    const resource = uploadPath(source);
    if (resource) req.query.url = resource;
    res.setHeader('Cache-Control', 'no-store'); next(); return;
  }
  const owner=mediaUser(req),resource=uploadPath(source);
  const parsed=new URL(source||'/', 'http://local.invalid');
  if(!(owner&&(ownsResultUrl(owner,source)||canReviewResultUrl(owner,source)))&&!(resource&&validMediaSignature(resource,parsed.searchParams.get('expires'),parsed.searchParams.get('signature')))) {res.status(404).json({error:'视频不存在或无权访问'});return;}
  if(resource)req.query.url=resource;
  res.setHeader('Cache-Control','private, no-store');next();
};
