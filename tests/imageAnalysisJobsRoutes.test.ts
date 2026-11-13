import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import express from 'express';
import sharp from 'sharp';
import fs from 'node:fs';
import type { Server } from 'node:http';
vi.mock('../server/db/index.js', async () => {
  const {default: Database} = await import('better-sqlite3'); const sqlite = new Database(':memory:');
  sqlite.exec(`CREATE TABLE usage_logs(id INTEGER PRIMARY KEY,user_id INTEGER,analysis_type TEXT,model_id INTEGER,status TEXT,created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE models(id INTEGER PRIMARY KEY,model_id TEXT,api_key TEXT,is_active INTEGER);
    CREATE TABLE users(id INTEGER PRIMARY KEY,is_active INTEGER);
    INSERT INTO models VALUES(1,'gemini-2.5-flash',NULL,1); INSERT INTO users VALUES(7,1);`);
  return {sqlite};
});
const mock = vi.hoisted(()=>({analyze:vi.fn(),save:vi.fn()}));
vi.mock('../server/services/aiService.js',()=>({AIService:{analyzeImage:mock.analyze}}));
vi.mock('../server/services/contentService.js',()=>({ContentService:{save:mock.save}}));
vi.mock('../server/middleware/auth.js',()=>({authMiddleware:(req:any,res:any,next:any)=>{req.userId=Number(req.headers['x-user']);if(!req.userId)return res.sendStatus(401);next();}}));
vi.mock('../server/middleware/tier.js',()=>({tierMiddleware:()=> (req:any,_res:any,next:any)=>{req.userTier={dailyQuota:Number(req.headers['x-quota']||100)};req.availableModels=[{id:1,modelId:'gemini-2.5-flash',apiKey:null}];next();}}));
import { imageAnalysisJobsRouter } from '../server/routes/imageAnalysisJobs';
import { imageAnalysisJobs, runImageAnalysisJobs } from '../server/services/imageAnalysisJobs';
let server:Server, base:string, png:Buffer;
const result=(name:string)=>({overallConcept:name,reversePrompt:name,reversePromptTranslation:name,aspectRatio:'1:1',keywords:[],styleTags:[]});
beforeAll(async()=>{
  png=await sharp({create:{width:8,height:8,channels:3,background:'red'}}).png().toBuffer();
  const app=express();app.use('/jobs',imageAnalysisJobsRouter);
  server=await new Promise<Server>(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});base='http://127.0.0.1:'+(server.address() as any).port+'/jobs';
});
afterAll(async()=>{
  for(const row of imageAnalysisJobs.database.prepare('SELECT file_path FROM image_analysis_items').all() as any[]) fs.unlinkSync(row.file_path);
  server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));imageAnalysisJobs.database.close();
});
const headers={'x-user':'7'};
function form(id:string){const f=new FormData();f.append('requestId',id);f.append('modelId','gemini-2.5-flash');f.append('imageRequiresText','true');for(let i=0;i<2;i++)f.append('files',new Blob([new Uint8Array(png)],{type:'image/png'}),'image.png');return f;}
it('executes both images in the real worker, preserves failure details, and deduplicates repeated HTTP submits',async()=>{
  mock.analyze.mockResolvedValueOnce(result('first')).mockRejectedValueOnce(Object.assign(new Error('Gemini INVALID_ARGUMENT: 图片格式错误'),{imageOutcome:'rejected'}));
  const id='http-image-job-123456';
  expect((await fetch(base,{method:'POST',headers,body:form(id)})).status).toBe(202);
  await vi.waitFor(()=>expect(imageAnalysisJobs.get(7,id)?.items.map(x=>x.status)).toEqual(['completed','error']));
  const read=await fetch(base+'/'+id,{headers}).then(r=>r.json());expect(read.items[0].result.overallConcept).toBe('first');expect(read.items[1].error).toContain('INVALID_ARGUMENT');
  expect((await fetch(base,{method:'POST',headers,body:form(id)})).status).toBe(200);
  await runImageAnalysisJobs();expect(mock.analyze).toHaveBeenCalledTimes(2);expect(mock.save).toHaveBeenCalledTimes(1);
  expect((await fetch(base+'/'+id,{headers:{'x-user':'8'}})).status).toBe(404);
  expect((await fetch(base+'/'+id+'/images/0',{headers:{'x-user':'8'}})).status).toBe(404);
  expect((await fetch(base+'/'+id+'/images/0',{headers})).headers.get('content-type')).toContain('image/jpeg');
});
it('continues other images after an unknown submission, without releasing its reserved quota or replaying it',async()=>{
  const before=mock.analyze.mock.calls.length;
  mock.analyze.mockRejectedValueOnce(Object.assign(new Error('socket disconnected'),{imageOutcome:'unknown'})).mockResolvedValueOnce(result('second'));
  const id='http-image-job-unknown';
  await fetch(base,{method:'POST',headers,body:form(id)});
  await vi.waitFor(()=>expect(imageAnalysisJobs.get(7,id)?.items.map(x=>x.status)).toEqual(['interrupted','completed']));
  await runImageAnalysisJobs();expect(mock.analyze.mock.calls.length-before).toBe(2);
  const held:any=imageAnalysisJobs.database.prepare("SELECT count(*) AS n FROM usage_logs WHERE status='reserved'").get();expect(held.n).toBe(1);
});
it('rejects insufficient quota before sending any model requests',async()=>{
  const before=mock.analyze.mock.calls.length;
  expect((await fetch(base,{method:'POST',headers:{...headers,'x-quota':'1'},body:form('http-quota-job-123456')})).status).toBe(429);
  expect(mock.analyze.mock.calls.length).toBe(before);
  expect(imageAnalysisJobs.get(7,'http-quota-job-123456')).toBeNull();
});
