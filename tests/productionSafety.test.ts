import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Database from 'better-sqlite3';
vi.mock('../server/db/index.js', async()=>{
  const {default:Database}=await import('better-sqlite3');
  const {drizzle}=await import('drizzle-orm/better-sqlite3');
  const schema=await import('../server/db/schema.js');
  const sqlite=new Database(':memory:');return {sqlite,db:drizzle(sqlite,{schema})};
});
import { sqlite } from '../server/db/index.js';
import { env } from '../server/config/env.js';
import { validateProductionConfig } from '../server/config/production.js';
import mediaRoutes from '../server/routes/media.js';
import authRoutes from '../server/routes/auth.js';
import billingRoutes from '../server/routes/billingAdmin.js';
import { privateReferences } from '../server/middleware/privateReferences.js';
import { protectUploads, protectVideoSource } from '../server/middleware/uploadAccess.js';
import { signedMediaUrl, mediaSignature } from '../server/services/mediaSignature.js';
import { registerUpload } from '../server/services/uploadAccess.js';
import { materializeContentMetadataAssets } from '../server/services/contentService.js';
import { createPrivateMediaStore } from '../server/services/privateMediaStore.js';
import { createBackup, verifyBackup } from '../scripts/backup.mjs';

const temp=fs.mkdtempSync(path.join(os.tmpdir(),'production-safety-'));
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6O1sAAAAASUVORK5CYII=','base64');
let server:Server,base:string;
const token=(userId:number,role='user')=>jwt.sign({userId,role},env.JWT_SECRET,{expiresIn:'1h'});
const headers=(userId=1)=>({'Content-Type':'application/json',Authorization:`Bearer ${token(userId)}`});
beforeAll(async()=>{
  vi.stubEnv('MEDIA_STORAGE_DIR',path.join(temp,'private'));
  sqlite.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,role TEXT,is_active INTEGER,balance REAL,updated_at TEXT);
    INSERT INTO users VALUES(1,'user',1,10,NULL),(2,'user',1,20,NULL),(3,'super_admin',1,0,NULL);
    CREATE TABLE contents(id INTEGER PRIMARY KEY,user_id INTEGER,result_url TEXT,metadata TEXT,cost REAL,type TEXT,status TEXT);`);
  const app=express();app.use(express.json({limit:'60mb'}));
  app.use('/api/media',mediaRoutes);app.use('/api/auth',authRoutes);app.use('/api/admin/billing-reservations',billingRoutes);
  app.post('/references',privateReferences,(req,res)=>res.json(req.body));
  app.use('/uploads',protectUploads,express.static(temp));app.use('/api/uploads',protectUploads,express.static(temp));
  app.get('/video',protectVideoSource,(_req,res)=>res.json({ok:true}));
  server=await new Promise(resolve=>{const listener=app.listen(0,'127.0.0.1',()=>resolve(listener));});
  base=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async()=>{await new Promise<void>(resolve=>server.close(()=>resolve()));sqlite.close();vi.unstubAllEnvs();fs.rmSync(temp,{recursive:true,force:true});});

describe('production release safety',()=>{
  it('allows anonymous completed video links, aliases and downloads, but keeps references and unfinished results private', async () => {
    const result = '/uploads/public-result.mp4';
    const reference = '/uploads/public-reference.mp4';
    fs.writeFileSync(path.join(temp, 'public-result.mp4'), Buffer.from('public video bytes'));
    fs.writeFileSync(path.join(temp, 'public-reference.mp4'), Buffer.from('private reference bytes'));
    const id = sqlite.prepare("INSERT INTO contents(user_id,type,status,result_url,metadata) VALUES(1,'video','completed',?,?)")
      .run(result, JSON.stringify({ reference_videos: [reference] })).lastInsertRowid;
    for (const prefix of ['/uploads', '/api/uploads']) {
      const response = await fetch(`${base}${prefix}/public-result.mp4?expires=1&signature=expired`, { headers: { Range: 'bytes=0-3' } });
      expect(response.status).toBe(206);
      expect(await response.text()).toBe('publ');
      expect((await fetch(`${base}${prefix}/public-result.mp4`, { method: 'HEAD' })).status).toBe(200);
      expect((await fetch(`${base}${prefix}/public-reference.mp4`)).status).toBe(404);
    }
    expect((await fetch(`${base}/video?url=${encodeURIComponent(result)}`)).status).toBe(200);
    expect((await fetch(`${base}/video?url=${encodeURIComponent(reference)}`)).status).toBe(404);
    const remote = 'https://cdn.example.test/public-result.mp4';
    sqlite.prepare("INSERT INTO contents(user_id,type,status,result_url) VALUES(1,'video','completed',?)").run(remote);
    expect((await fetch(`${base}/video?url=${encodeURIComponent(remote)}`)).status).toBe(200);
    expect((await fetch(`${base}/video?url=${encodeURIComponent('https://cdn.example.test/unrecorded.mp4')}`)).status).toBe(404);
    for (const status of ['processing', 'failed', 'review']) {
      sqlite.prepare('UPDATE contents SET status=? WHERE id=?').run(status, id);
      expect((await fetch(`${base}${result}`)).status).toBe(404);
    }
    sqlite.prepare("UPDATE contents SET type='image',status='completed' WHERE id=?").run(id);
    expect((await fetch(`${base}${result}`)).status).toBe(404);
    sqlite.prepare('DELETE FROM contents WHERE id=?').run(id);
    expect((await fetch(`${base}${result}`)).status).toBe(404);
  });
  it('fails closed on missing production credentials and insecure origins',()=>{
    expect(()=>validateProductionConfig({NODE_ENV:'production'})).toThrow('生产配置');
    const good={NODE_ENV:'production',JWT_SECRET:'b8a4d021861e4bb2b5f3dbd3f90eb617',ADMIN_PASSWORD:'random-secret-299374',BACKEND_URL:'https://studio.test',ALLOWED_ORIGINS:'https://studio.test'};
    expect(()=>validateProductionConfig(good)).not.toThrow();
    expect(()=>validateProductionConfig({...good,BACKEND_URL:'http://studio.test'})).toThrow();
    expect(()=>validateProductionConfig({...good,ALLOWED_ORIGINS:'*'})).toThrow();
  });
  it('blocks simulated recharge without altering the balance',async()=>{
    const r=await fetch(`${base}/api/auth/recharge`,{method:'POST',headers:headers(),body:JSON.stringify({amount:100000})});
    expect(r.status).toBe(403);expect(sqlite.prepare('SELECT balance FROM users WHERE id=1').get()).toEqual({balance:10});
  });
  it('checks current admin role instead of trusting a forged or outdated role claim',async()=>{
    const r=await fetch(`${base}/api/admin/billing-reservations`,{headers:{Authorization:`Bearer ${token(1,'super_admin')}`}});
    expect(r.status).toBe(403);
    expect((await fetch(`${base}/api/admin/billing-reservations`,{headers:headers(3)})).status).toBe(200);
  });
  it('publishes media for anonymous reading while retaining owner-only upload management',async()=>{
    const body=JSON.stringify({dataUrl:`data:image/png;base64,${png.toString('base64')}`,filename:'参考.png'});
    const upload=await fetch(`${base}/api/media`,{method:'POST',headers:headers(),body});expect(upload.status).toBe(201);
    const cookie=upload.headers.get('set-cookie')!.split(';')[0];expect(cookie).toContain('media_session=');
    const media=await upload.json();
    expect((await fetch(`${base}${media.url}`)).status).toBe(200);
    expect((await fetch(`${base}${media.url}`,{headers:headers(2)})).status).toBe(200);
    expect((await fetch(`${base}${media.url}/link`,{method:'POST',headers:headers(2)})).status).toBe(404);
    const own=await fetch(`${base}${media.url}`,{headers:{Cookie:cookie,Range:'bytes=0-7'}});expect(own.status).toBe(206);expect((await own.arrayBuffer()).byteLength).toBe(8);
    const again=await fetch(`${base}/api/media`,{method:'POST',headers:headers(),body}).then(r=>r.json());expect(again.id).toBe(media.id);
    const other=await fetch(`${base}/api/media`,{method:'POST',headers:headers(2),body}).then(r=>r.json());expect(other.id).not.toBe(media.id);
    const reference=await fetch(`${base}/references`,{method:'POST',headers:headers(),body:JSON.stringify({reference_videos:[media.url]})}).then(r=>r.json());expect(reference.reference_videos[0]).toBe(`data:image/png;base64,${png.toString('base64')}`);
    expect((await fetch(`${base}/references`,{method:'POST',headers:headers(2),body:JSON.stringify({reference_images:[media.url]})})).status).toBe(400);
    const signed=await fetch(`${base}${media.url}/link`,{method:'POST',headers:headers()}).then(r=>r.json());expect((await fetch(signed.url)).status).toBe(200);
    const expired=Math.floor(Date.now()/1000)-1;expect((await fetch(`${base}${media.url}?expires=${expired}&signature=${mediaSignature(media.url,expired)}`)).status).toBe(200);
  });
  it('rejects active content disguised as media and enforces quota',()=>{
    const db=new Database(':memory:');const store=createPrivateMediaStore(db,path.join(temp,'quota'));
    expect(()=>store.put(1,Buffer.from('<svg onload="alert(1)"></svg>'),'image/png','fake.png')).toThrow('不支持');
    vi.stubEnv('MEDIA_USER_QUOTA_MB','0');expect(()=>store.put(1,png,'image/png','a.png')).toThrow('空间已满');vi.stubEnv('MEDIA_USER_QUOTA_MB','2048');db.close();
  });
  it('protects both historical upload aliases and video proxy against bypass',async()=>{
    fs.writeFileSync(path.join(temp,'private-test.png'),png);registerUpload('/uploads/private-test.png',1);
    for(const prefix of ['/uploads','/api/uploads']) {
      expect((await fetch(`${base}${prefix}/private-test.png`)).status).toBe(404);
      expect((await fetch(`${base}${prefix}/private-test.png`,{headers:headers(2)})).status).toBe(404);
      expect((await fetch(`${base}${prefix}/private-test.png`,{headers:headers()})).status).toBe(200);
    }
    const signed=signedMediaUrl('/uploads/private-test.png',base);expect((await fetch(signed)).status).toBe(200);
    expect((await fetch(signed.replace('private-test','other'))).status).toBe(404);
    expect((await fetch(`${base}/video?url=${encodeURIComponent('/uploads/private-test.png')}`)).status).toBe(404);
    expect((await fetch(`${base}/references`,{method:'POST',headers:headers(2),body:JSON.stringify({reference_images:['/uploads/private-test.png']})})).status).toBe(400);
  });
  it('allows current admins to review recorded user results through cookie playback only, with role revocation enforced', async()=>{
    const local='/uploads/admin-review.mp4', remote='https://video.example.test/result.mp4';
    fs.writeFileSync(path.join(temp,'admin-review.mp4'), Buffer.from('test video'));
    sqlite.prepare('INSERT INTO contents(user_id,result_url,metadata) VALUES(1,?,?)').run(local,'{}');
    sqlite.prepare('INSERT INTO contents(user_id,result_url,metadata) VALUES(1,?,?)').run(remote,'{}');
    const adminHeaders={Cookie:`media_session=${token(3)}`};
    for (const url of [local,remote]) {
      const endpoint=`${base}/video?url=${encodeURIComponent(url)}`;
      expect((await fetch(endpoint,{headers:adminHeaders})).status).toBe(200);
      expect((await fetch(endpoint,{headers:headers(2)})).status).toBe(404);
      expect((await fetch(endpoint)).status).toBe(404);
      expect((await fetch(endpoint,{headers:{Cookie:`media_session=${token(2,'super_admin')}`}})).status).toBe(404);
    }
    for (const prefix of ['/uploads','/api/uploads']) {
      expect((await fetch(`${base}${prefix}/admin-review.mp4`,{headers:{...adminHeaders,Range:'bytes=0-3'}})).status).toBe(206);
    }
    expect((await fetch(`${base}/video?url=${encodeURIComponent('https://video.example.test/unrecorded.mp4')}`,{headers:adminHeaders})).status).toBe(404);
    sqlite.prepare('UPDATE users SET role=? WHERE id=3').run('user');
    try {
      expect((await fetch(`${base}${local}`,{headers:adminHeaders})).status).toBe(404);
    } finally { sqlite.prepare('UPDATE users SET role=? WHERE id=3').run('super_admin'); }
  });
  it('backs up WAL database and media, detects tampering, and restores a readable copy',async()=>{
    const data=path.join(temp,'live'),backup=path.join(temp,'backup');fs.mkdirSync(path.join(data,'private-media'),{recursive:true});
    const db=new Database(path.join(data,'app.db'));db.pragma('journal_mode=WAL');db.exec('CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES (\'saved\')');
    fs.writeFileSync(path.join(data,'private-media','sample.bin'),png);
    await createBackup(data,backup);await verifyBackup(backup);
    const restored=new Database(path.join(backup,'app.db'),{readonly:true});expect(restored.prepare('SELECT value FROM proof').get()).toEqual({value:'saved'});restored.close();
    fs.writeFileSync(path.join(backup,'private-media','sample.bin'),'broken');await expect(verifyBackup(backup)).rejects.toThrow('verification failed');db.close();
  });
  it('lets admins review persisted task references without making them public or granting another user ownership', async()=>{
    const resource='/uploads/history-assets/reference-review.png';
    fs.mkdirSync(path.join(temp,'history-assets'),{recursive:true});
    fs.writeFileSync(path.join(temp,'history-assets/reference-review.png'),png);
    sqlite.prepare('INSERT INTO contents(user_id,result_url,metadata) VALUES(1,NULL,?)')
      .run(JSON.stringify({reference_images:[resource]}));
    expect((await fetch(`${base}${resource}`,{headers:{Cookie:`media_session=${token(3)}`}})).status).toBe(200);
    const replicateBody=JSON.stringify({reference_images:[resource],reference_videos:[resource],audio_urls:[resource],first_frame:resource,last_frame:resource});
    const replicated=await fetch(`${base}/references`,{method:'POST',headers:headers(3),body:replicateBody});
    expect(replicated.status).toBe(200);
    expect(await replicated.json()).toEqual(JSON.parse(replicateBody));
    expect((await fetch(`${base}/references`,{method:'POST',headers:headers(2),body:replicateBody})).status).toBe(400);
    expect((await fetch(`${base}/references`,{method:'POST',headers:headers(3),body:JSON.stringify({reference_images:['/uploads/unrecorded.png']})})).status).toBe(400);
    expect((await fetch(`${base}${resource}`)).status).toBe(404);
    expect((await fetch(`${base}${resource}`,{headers:headers(2)})).status).toBe(404);
    sqlite.prepare('INSERT INTO contents(user_id,result_url,metadata) VALUES(2,NULL,?)')
      .run(JSON.stringify({reference_images:[resource]}));
    expect((await fetch(`${base}${resource}`,{headers:headers(2)})).status).toBe(404);
    registerUpload(resource,1);
    expect((await fetch(`${base}${resource}`,{headers:headers(1)})).status).toBe(200);
    expect((await fetch(`${base}/uploads/unrecorded.png`,{headers:headers(3)})).status).toBe(404);
  });
  it('registers the actual task owner when materializing inline references', async()=>{
    const result=materializeContentMetadataAssets({reference_images:[`data:image/png;base64,${png.toString('base64')}`]},
      {uploadDir:path.join(temp,'history-assets'),ownerId:1});
    const source=result.metadata.reference_images[0];
    expect((await fetch(`${base}${source}`,{headers:headers(1)})).status).toBe(200);
    expect((await fetch(`${base}${source}`,{headers:headers(2)})).status).toBe(404);
    expect((await fetch(`${base}${source}`)).status).toBe(404);
  });
});
