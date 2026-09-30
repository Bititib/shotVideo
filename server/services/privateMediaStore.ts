import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export type PrivateMedia = { id: string; user_id: number; mime: string; bytes: number; filename: string; digest: string };
export function detectedMediaMime(bytes: Buffer, declared: string): string | null {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0]===255&&bytes[1]===216&&bytes[2]===255) return 'image/jpeg';
  if (/^GIF8[79]a/.test(bytes.subarray(0,6).toString())) return 'image/gif';
  if (bytes.subarray(0,4).toString()==='RIFF') {
    if (bytes.subarray(8,12).toString()==='WEBP') return 'image/webp';
    if (bytes.subarray(8,12).toString()==='WAVE') return 'audio/wav';
  }
  if (bytes.subarray(4,8).toString()==='ftyp') {
    if (['avif','avis'].includes(bytes.subarray(8,12).toString())) return 'image/avif';
    return declared==='audio/mp4'?'audio/mp4':'video/mp4';
  }
  if (bytes.subarray(0,4).equals(Buffer.from([26,69,223,163]))) return declared==='audio/webm'?'audio/webm':'video/webm';
  if (bytes.subarray(0,4).toString()==='OggS') return 'audio/ogg';
  if (bytes.subarray(0,3).toString()==='ID3'||bytes[0]===255&&(bytes[1]&224)===224) return 'audio/mpeg';
  return null;
}

export function createPrivateMediaStore(database: Database.Database, root: string) {
  database.exec(`CREATE TABLE IF NOT EXISTS private_media (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, mime TEXT NOT NULL, bytes INTEGER NOT NULL,
    filename TEXT NOT NULL, digest TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')), UNIQUE(user_id,digest)
  ); CREATE INDEX IF NOT EXISTS private_media_owner ON private_media(user_id);`);
  const get = (id: string) => /^[a-f0-9-]{36}$/.test(id) ? database.prepare('SELECT * FROM private_media WHERE id=?').get(id) as PrivateMedia|undefined : undefined;
  const filePath = (media: PrivateMedia) => path.join(root, `${media.id}.bin`);
  const put = database.transaction((owner: number, bytes: Buffer, declared: string, filename: string) => {
    if (!Number.isSafeInteger(owner)||owner<1) throw new Error('素材账号无效');
    const mime=detectedMediaMime(bytes,declared);
    if (!mime||!bytes.length||bytes.length>(mime.startsWith('image/')?20:40)*1024*1024) throw new Error('不支持的素材内容，图片限 20 MB，视频和音频限 40 MB');
    const digest=createHash('sha256').update(bytes).digest('hex');
    const existing=database.prepare('SELECT * FROM private_media WHERE user_id=? AND digest=?').get(owner,digest) as PrivateMedia|undefined;
    if (existing&&fs.existsSync(filePath(existing))) return existing;
    const quota=Number(process.env.MEDIA_USER_QUOTA_MB||2048)*1024*1024;
    const used=(database.prepare('SELECT coalesce(sum(bytes),0) AS n FROM private_media WHERE user_id=?').get(owner) as {n:number}).n;
    if (!existing&&used+bytes.length>quota) throw new Error('账号素材空间已满，请联系管理员扩容');
    const media: PrivateMedia=existing||{id:randomUUID(),user_id:owner,mime,bytes:bytes.length,filename:path.basename(filename||'素材').slice(0,160),digest};
    fs.mkdirSync(root,{recursive:true});
    const temp=path.join(root,`${media.id}.${randomUUID()}.tmp`);
    try {fs.writeFileSync(temp,bytes,{flag:'wx',mode:0o600});fs.renameSync(temp,filePath(media));}
    finally {if(fs.existsSync(temp))fs.unlinkSync(temp);}
    if (!existing) database.prepare('INSERT INTO private_media(id,user_id,mime,bytes,filename,digest) VALUES(@id,@user_id,@mime,@bytes,@filename,@digest)').run(media);
    return media;
  });
  return {get,put,filePath};
}
