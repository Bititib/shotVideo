import type { RequestHandler } from 'express';
import fs from 'node:fs';
import { mediaUser, privateMediaStore } from '../routes/media.js';
import { ownsUpload, uploadPath } from '../services/uploadAccess.js';
import { validMediaSignature } from '../services/mediaSignature.js';

/** Resolve owned stable media IDs before provider adapters; never forward a login token. */
export const privateReferences: RequestHandler = (req,res,next) => {
  if(req.method!=='POST'||!req.body) {next();return;}
  const cache=new Map<string,string>();let total=0;
  const walk=(value: any):any=>{
    if(typeof value==='string'&&(value.startsWith('/uploads/')||value.startsWith('/api/uploads/')||/^https?:/.test(value))) {
      const resource=uploadPath(value);
      if(resource) {
        const parsed=new URL(value,'http://local.invalid'),owner=mediaUser(req);
        if(!(owner&&ownsUpload(owner,value))&&!validMediaSignature(resource,parsed.searchParams.get('expires'),parsed.searchParams.get('signature'))) throw new Error('参考素材不存在或无权访问，请重新选择');
      }
    }
    if(typeof value==='string'&&value.startsWith('/api/media/')) {
      if(cache.has(value))return cache.get(value);
      const match=/^\/api\/media\/([a-f0-9-]{36})$/.exec(value);
      const media=match&&privateMediaStore().get(match[1]);
      if(!media||media.user_id!==mediaUser(req))throw new Error('参考素材不存在或无权访问，请重新选择');
      total+=media.bytes;if(total>120*1024*1024)throw new Error('参考素材总量超过 120 MB，请减少素材');
      const data=`data:${media.mime};base64,${fs.readFileSync(privateMediaStore().filePath(media)).toString('base64')}`;
      cache.set(value,data);return data;
    }
    if(Array.isArray(value))return value.map(walk);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,walk(v)]));
    return value;
  };
  try {req.body=walk(req.body);next();}catch(e){res.status(400).json({error:(e as Error).message});}
};
