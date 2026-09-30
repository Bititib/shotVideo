import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
let sqlite: Database.Database | undefined;
export function configureUploadAccess(database: Database.Database) { sqlite=database; }
import { signedMediaUrl } from './mediaSignature.js';

export const mediaOwnerContext = new AsyncLocalStorage<number>();
export function uploadPath(source: string): string | null {
  try {
    const u=new URL(source,'http://local.invalid');
    if (/^https?:/.test(source)&&process.env.BACKEND_URL&&u.origin!==new URL(process.env.BACKEND_URL).origin) return null;
    const pathname=decodeURIComponent(u.pathname).replace(/^\/api\/uploads\//,'/uploads/');
    if (!pathname.startsWith('/uploads/')||pathname.includes('\\')||pathname.includes('\0')||pathname.split('/').some(p=>p==='..'||p==='.')) return null;
    return pathname;
  } catch {return null;}
}
function ensure() {sqlite.exec('CREATE TABLE IF NOT EXISTS upload_owners (path TEXT NOT NULL, user_id INTEGER NOT NULL, PRIMARY KEY(path,user_id))');}
export function registerUpload(source: string, owner=mediaOwnerContext.getStore()) {
  const resource=uploadPath(source);
  if(resource&&owner&&sqlite) {ensure();sqlite.prepare('INSERT OR IGNORE INTO upload_owners(path,user_id) VALUES(?,?)').run(resource,owner);}
  return source;
}
/** Only use on a freshly written file or an already-authorized reference. */
export function issueUploadUrl(source: string, base?: string, seconds=3600) {
  const resource=uploadPath(/^https?:/.test(source) ? new URL(source).pathname : source);if(!resource)return source;
  registerUpload(resource);
  const origin=base||(/^https?:/.test(source)?new URL(source).origin:process.env.BACKEND_URL||'');
  return signedMediaUrl(resource,origin,seconds);
}
export function ownsUpload(owner: number, source: string): boolean {
  const resource=uploadPath(source);if(!resource||!sqlite)return false;
  ensure();
  if(sqlite.prepare('SELECT 1 FROM upload_owners WHERE path=? AND user_id=?').get(resource,owner))return true;
  // Backward compatibility: only generated result fields establish ownership.
  // User-editable canvas documents and submitted reference fields cannot grant it.
  if(!sqlite.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contents'").get())return false;
  const records=sqlite.prepare('SELECT result_url,metadata FROM contents WHERE user_id=? AND (result_url LIKE ? OR metadata LIKE ?)').all(owner,`%${resource.split('/').pop()}%`,`%${resource.split('/').pop()}%`) as any[];
  const found=records.some(row=>{
    let meta:any={};try{meta=JSON.parse(row.metadata||'{}');}catch{}
    return [row.result_url,...(Array.isArray(meta.imageUrls)?meta.imageUrls:[])].some(src=>typeof src==='string'&&uploadPath(src)===resource);
  });
  if(found)registerUpload(source,owner);
  return found;
}

export function ownsResultUrl(owner: number, source: string): boolean {
  if(uploadPath(source))return ownsUpload(owner,source);
  if(!sqlite||!/^https?:\/\//.test(source))return false;
  return !!sqlite.prepare('SELECT 1 FROM contents WHERE user_id=? AND result_url=? LIMIT 1').get(owner,source);
}
