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

/** Only completed video result fields are public. Reference metadata, uploaded
 * materials, images and in-progress/failed tasks must never grant public access. */
export function isPublicVideoResult(source: string): boolean {
  if (!sqlite || !source) return false;
  const resource = uploadPath(source);
  if (!resource) {
    if (!/^https?:\/\//.test(source)) return false;
    return !!sqlite.prepare("SELECT 1 FROM contents WHERE type='video' AND status='completed' AND result_url=? LIMIT 1").get(source);
  }
  const basename = resource.split('/').pop();
  if (!basename) return false;
  const candidates = sqlite.prepare("SELECT result_url FROM contents WHERE type='video' AND status='completed' AND result_url LIKE ?")
    .all(`%${basename}%`) as { result_url: string }[];
  return candidates.some(row => uploadPath(row.result_url) === resource);
}

/** Admin review is limited to recorded results and local task references. */
export function canReviewResultUrl(viewer: number, source: string): boolean {
  if (!sqlite) return false;
  const account = sqlite.prepare('SELECT role,is_active FROM users WHERE id=?').get(viewer) as any;
  if (!account?.is_active || !['admin', 'super_admin'].includes(account.role)) return false;
  const resource = uploadPath(source);
  if (!resource) {
    return /^https?:\/\//.test(source)
      && !!sqlite.prepare('SELECT 1 FROM contents WHERE result_url=? LIMIT 1').get(source);
  }
  const basename = resource.split('/').pop();
  const records = sqlite.prepare('SELECT result_url,metadata FROM contents WHERE result_url LIKE ? OR metadata LIKE ?')
    .all(`%${basename}%`, `%${basename}%`) as any[];
  return records.some(row => {
    let meta: any = {};
    try { meta = JSON.parse(row.metadata || '{}'); } catch {}
    const referenceFields = ['reference_images', 'image_urls', 'images', 'image_refs', 'referenceImages', 'reference_image', 'image_url',
      'reference_videos', 'video_urls', 'videos', 'video_refs', 'referenceVideos', 'reference_video', 'video_url',
      'audio_urls', 'reference_audios', 'audios', 'audio_refs', 'referenceAudios', 'audio_url', 'reference_audio',
      'first_frame', 'first_frame_url', 'firstFrame', 'last_frame', 'last_frame_url', 'lastFrame', 'end_frame_url'];
    const references = referenceFields.flatMap(key => Array.isArray(meta[key]) ? meta[key] : [meta[key]]);
    return [row.result_url, ...(Array.isArray(meta.imageUrls) ? meta.imageUrls : []), ...references]
      .some(src => typeof src === 'string' && uploadPath(src) === resource);
  });
}
