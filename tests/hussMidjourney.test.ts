import { beforeAll, beforeEach, afterEach, afterAll, it, expect, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
 const {default:Database}=await import('better-sqlite3'); const {drizzle}=await import('drizzle-orm/better-sqlite3');
 const sqlite=new Database(':memory:');return {sqlite,db:drizzle(sqlite)};
});
vi.mock('../server/services/channelService.js',()=>({ChannelService:{getActiveChannels:vi.fn(()=>[]),getChannelRaw:vi.fn()}}));
vi.mock('../server/routes/imageGen.js',()=>({localizeGeneratedImage:vi.fn(async (_:string,prefix:string)=>'/api/uploads/'+prefix+'.png')}));
import {db,sqlite} from '../server/db/index.js';
import {reserveUserCharge} from '../server/services/billingReservation.js';
import {initDatabase} from '../server/db/seed.js';
import {models,users,contents,settings,channels} from '../server/db/schema.js';
import {ChannelService} from '../server/services/channelService.js';
import {saveModelSpecification} from '../server/services/modelRoutingService.js';
import {handleSpecificationGeneration,resumeSpecificationTasks} from '../server/services/specificationGenerationService.js';
import {HUSS_MJ_MODEL,hussMjLimits,hussMjOptions} from '../shared/hussMidjourney.js';
import {syncHussModels} from '../server/services/hussCatalogService.js';
import {normalizeHussImage,downloadHussImage} from '../server/services/hussImageAdapter.js';
import {eq} from 'drizzle-orm';
import sharp from 'sharp';
let userId:number, png:Buffer;
const channel={id:55,type:'huss',baseUrl:'https://huss.test',apiKey:'test-key',apiKeyId:null,priority:0,status:1,supportedModels:[HUSS_MJ_MODEL],modelMapping:{}};
beforeAll(async()=>{
 process.env.ADMIN_EMAIL='huss-mj@test.com';process.env.ADMIN_PASSWORD='test-only-password';await initDatabase();
 userId=db.select().from(users).all()[0].id;
 db.insert(models).values({modelId:HUSS_MJ_MODEL,displayName:HUSS_MJ_MODEL,provider:'huss',capabilities:'["image"]',isActive:1}).run();
 db.insert(channels).values({id:55,name:'HUSS',type:'huss',baseUrl:channel.baseUrl}).run();
 sqlite.prepare('INSERT INTO model_pricing(model_pattern,billing_type,input_price,output_price,extra_params) VALUES(?,?,?,?,?)').run(HUSS_MJ_MODEL,'per_call',2,0,'{}');
 png=await sharp({create:{width:4,height:4,channels:3,background:'red'}}).png().toBuffer();
});
beforeEach(()=>{
 vi.useFakeTimers();db.delete(contents).run();db.delete(settings).run();
 db.update(users).set({balance:100}).where(eq(users.id,userId)).run();
 vi.mocked(ChannelService.getActiveChannels).mockReturnValue([channel]);vi.mocked(ChannelService.getChannelRaw).mockReturnValue(channel);
 saveModelSpecification({modelId:HUSS_MJ_MODEL,kind:'image',enabled:true,aliases:[],limits:hussMjLimits(),routes:[{id:'huss-mj',channelId:55,executionModel:HUSS_MJ_MODEL,upstreamModel:HUSS_MJ_MODEL,enabled:true,limits:hussMjLimits(),cost:null,costUnit:'unknown',resolutionCosts:{},priority:0}]});
});
afterEach(()=>{vi.clearAllTimers();vi.useRealTimers();vi.unstubAllGlobals();});
afterAll(()=>sqlite.close());
function row(){return db.select().from(contents).all().at(-1)!;}
function meta(){return JSON.parse(row().metadata);}
async function submit(extra={}){
 const res:any={writableEnded:false,destroyed:false,headersSent:false,setHeader:vi.fn(),flushHeaders:vi.fn(),write:vi.fn(),end:vi.fn(),status:vi.fn(),json:vi.fn()};res.status.mockReturnValue(res);
 await handleSpecificationGeneration({body:{model:HUSS_MJ_MODEL,prompt:'水彩城堡',resolution:'2K',aspect_ratio:'1:1',n:1,...extra},userId,protocol:'https',get:()=> 'local.test'} as any,res,'image');return res;
}
const completed=()=>Response.json({task_id:'original-image',status:'completed',data:[{url:'https://cdn.test/1.png'},{url:'https://cdn.test/2.png'}]});
it('preserves style controls and seed zero without treating style names as modes',()=>{
 expect(hussMjOptions({stylize:'250',seed:0,tile:false,sref:'https://cdn.test/style.jpg'})).toMatchObject({stylize:'250',seed:0,tile:false});
 expect(()=>hussMjOptions({style:'anime'})).toThrow();expect(()=>hussMjOptions({draft:false})).toThrow();
});
it('persists the receipt before GET, keeps all candidates and settles one charge',async()=>{
 const fetcher=vi.fn(async(url:any,opts:any)=>{
  if(opts?.method==='POST'){expect(JSON.parse(opts.body)).toMatchObject({model:HUSS_MJ_MODEL,stylize:'250',seed:0,n:1});return Response.json({task_id:'original-image',status:'queued',poll_after_ms:1000});}
  if(String(url).includes('/tasks/')){expect(meta().upstreamTaskId).toBe('original-image');return completed();}
  return new Response(png,{headers:{'content-type':'image/png'}});
 });vi.stubGlobal('fetch',fetcher);await submit({stylize:'250',seed:0});expect(row().status).toBe('processing');
 await vi.advanceTimersByTimeAsync(1100);await vi.waitFor(()=>expect(row().status).toBe('completed'));expect(meta().imageUrls).toHaveLength(2);
 expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(98);
 resumeSpecificationTasks();expect(fetcher.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
});
it('refunds explicit rejection exactly once and never sends it into review',async()=>{
 const f=vi.fn(async()=>Response.json({error:{code:'invalid_image_request',message:'invalid style'}},{status:400}));vi.stubGlobal('fetch',f);
 await submit();expect(row().status).toBe('failed');expect(meta().requiresReview).not.toBe(true);
 resumeSpecificationTasks();await vi.advanceTimersByTimeAsync(60000);expect(f).toHaveBeenCalledTimes(1);
 expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(100);
});
it('retains ambiguous submission without replay or refund',async()=>{
 const f=vi.fn(async()=>{throw new TypeError('connection closed');});vi.stubGlobal('fetch',f);
 await submit();expect(meta().requiresReview).toBe(true);expect(row().status).not.toBe('failed');
 resumeSpecificationTasks();await vi.advanceTimersByTimeAsync(60000);expect(f).toHaveBeenCalledTimes(1);
 expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(98);
});
it('retries download after restart without regenerating or refunding successful output',async()=>{
 let failDownload=true;
 const f=vi.fn(async(url:any,opts:any)=>{
  if(opts?.method==='POST')return completed();if(String(url).includes('/tasks/'))return completed();
  return failDownload ? Response.json({error:{message:'signed URL expired'}},{status:403}) : new Response(png);
 });vi.stubGlobal('fetch',f);await submit();expect(row().status).toBe('processing');expect(meta().upstreamGenerated).toBe(true);expect(meta().resultSaveError).toContain('403');
 failDownload=false;vi.clearAllTimers();vi.setSystemTime(Date.now()+31000);resumeSpecificationTasks();await vi.advanceTimersByTimeAsync(10);
 await vi.waitFor(()=>expect(row().status).toBe('completed'));expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
 expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(98);
});
it('a query failure is recoverable; a terminal task failure refunds',async()=>{
 let count=0;const f=vi.fn(async(_:any,opts:any)=>{
 if(opts?.method==='POST')return Response.json({task_id:'original-image',status:'queued',poll_after_ms:1000});
 if(count++===0)return Response.json({error:{message:'busy'}},{status:503});
 return Response.json({task_id:'original-image',status:'failed',error:{code:'image_failed',message:'reference rejected'}});
 });vi.stubGlobal('fetch',f);await submit();await vi.advanceTimersByTimeAsync(1100);expect(row().status).toBe('processing');
 await vi.advanceTimersByTimeAsync(31000);expect(row().status).toBe('failed');expect(meta().error).toContain('reference rejected');
 expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(100);
});
it('does not infer completed from a pending store or malformed response',()=>{
 expect(normalizeHussImage({task_id:'x',status:'completed',storage_status:'pending'}).status).toBe('processing');
 expect(()=>normalizeHussImage({status:'completed',data:[]})).toThrow();
});
it('strips channel credentials on CDN redirects and validates downloaded image',async()=>{
 const f=vi.fn().mockResolvedValueOnce(new Response(null,{status:307,headers:{location:'https://cdn.test/image'}})).mockResolvedValueOnce(new Response(png));vi.stubGlobal('fetch',f);
 expect(await downloadHussImage(channel,'https://huss.test/media/1')).toMatch(/^data:image\/png;base64,/);
 expect(f.mock.calls[0][1].headers.Authorization).toBe('Bearer test-key');expect(f.mock.calls[1][1].headers.Authorization).toBeUndefined();
});

it('syncs an image-only HUSS key, preserves admin price and enabled status',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{id:HUSS_MJ_MODEL}]})));
 const result=await syncHussModels({...channel,name:'HUSS'});
 expect(result.models).toEqual([HUSS_MJ_MODEL]);
 const model=db.select().from(models).where(eq(models.modelId,HUSS_MJ_MODEL)).get()!;
 expect(model.isActive).toBe(1);expect(JSON.parse(model.capabilities)).toEqual(['image']);
 expect(sqlite.prepare('SELECT input_price FROM model_pricing WHERE model_pattern=?').get(HUSS_MJ_MODEL)).toMatchObject({input_price:2});
});

it('keeps partial downloads and retries only the missing candidate',async()=>{
 let failed=true; const f=vi.fn(async(url:any,opts:any)=>{
  if(opts?.method==='POST' || String(url).includes('/tasks/'))return completed();
  if(String(url).includes('/2.png') && failed)return new Response('denied',{status:403});
  return new Response(png);
 });vi.stubGlobal('fetch',f);await submit();expect(meta().nativeImageBatch.jobs[0].localUrl).toBeTruthy();
 failed=false;await vi.advanceTimersByTimeAsync(31000);await vi.waitFor(()=>expect(row().status).toBe('completed'));
 expect(f.mock.calls.filter(c=>String(c[0]).endsWith('/1.png'))).toHaveLength(1);
 expect(meta().imageUrls).toHaveLength(2);expect(row().cost).toBe(2);
});
it('submits one normal reference through edits with the independent style reference',async()=>{
 const f=vi.fn(async(_:any,opts:any)=>{
  expect(JSON.parse(opts.body)).toMatchObject({model:HUSS_MJ_MODEL,sref:'https://cdn.test/style.jpg',images:[{image_url:expect.stringMatching(/^data:image\/jpeg;base64,/)}]});
  return Response.json({error:{code:'invalid_image_request',message:'test rejection'}},{status:400});
 });vi.stubGlobal('fetch',f);await submit({reference_images:['data:image/png;base64,'+png.toString('base64')],sref:'https://cdn.test/style.jpg'});
 expect(f.mock.calls[0][0]).toBe('https://huss.test/v1/images/edits/async');expect(row().status).toBe('failed');
});
it('retains a valid receipt when its initial status is malformed and resumes by GET',async()=>{
 const f=vi.fn(async(url:any,opts:any)=>{
  if(opts?.method==='POST')return Response.json({task_id:'original-image',status:'new-status'});
  if(String(url).includes('/tasks/'))return completed();return new Response(png);
 });vi.stubGlobal('fetch',f);await submit();expect(row().status).toBe('completed');expect(meta().upstreamTaskId).toBe('original-image');
 expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
});
it('does not interpret expired delivery as refundable generation failure',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task_id:'original-image',status:'expired',error:{message:'result expired'}})));
 await submit();expect(meta().hussImageStopped).toBe(true);expect(meta().requiresReview).toBe(true);
 expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(98);
});

it('external API returns a local query handle and keeps the original reservation',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task_id:'original-image',status:'queued',poll_after_ms:5000})));
 const res:any={status:vi.fn(),json:vi.fn(),end:vi.fn()};res.status.mockReturnValue(res);
 await handleSpecificationGeneration({body:{model:HUSS_MJ_MODEL,prompt:'test',resolution:'1K',n:1},protocol:'https',get:()=> 'local.test'} as any,res,'image',{
  token:{id:700,userId,allowedModels:[]},reserve:(amount,model)=>reserveUserCharge(userId,amount,'api-test',{tokenId:700,model})
 });
 expect(res.status).toHaveBeenCalledWith(202);
 expect(res.json).toHaveBeenCalledWith(expect.objectContaining({task_id:'task_'+row().id,status:'processing',status_url:'https://local.test/v1/images/tasks/task_'+row().id}));
 expect(meta().upstreamTaskId).toBe('original-image');expect(meta().tokenId).toBe(700);
});

it.each(['expired','processing','failed'])('keeps saving known successful results despite later %s status',async(status)=>{
 let ready=false;
 const f=vi.fn(async(url:any,opts:any)=>{
  if(opts?.method==='POST')return completed();
  if(String(url).includes('/tasks/'))return Response.json({task_id:'original-image',status,error:{message:'later status'}});
  return ready ? new Response(png) : new Response('temporary download failure',{status:503});
 });vi.stubGlobal('fetch',f);await submit();expect(meta().upstreamGenerated).toBe(true);expect(row().status).toBe('processing');
 ready=true;await vi.advanceTimersByTimeAsync(31000);await vi.waitFor(()=>expect(row().status).toBe('completed'));
 expect(meta().imageUrls).toHaveLength(2);expect(meta().billingStatus).toBe('settled');
 expect(f.mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
 expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(98);
});
it('settles a fully saved original batch after restart without requiring the upstream query',async()=>{
 const f=vi.fn(async()=>Response.json({task_id:'original-image',status:'queued'}));vi.stubGlobal('fetch',f);await submit();
 const m=meta();m.hussImageInitial=null;m.hussImageResumeAt=0;m.upstreamGenerated=true;
 m.nativeImageBatch={sourceUrls:['https://cdn.test/1.png'],jobs:[{index:0,sourceUrl:'https://cdn.test/1.png',status:'completed',localUrl:'/api/uploads/already-saved.png'}]};
 db.update(contents).set({metadata:JSON.stringify(m)}).where(eq(contents.id,row().id)).run();
 f.mockClear();resumeSpecificationTasks();await vi.waitFor(()=>expect(row().status).toBe('completed'));
 expect(f).not.toHaveBeenCalled();expect(row().resultUrl).toBe('/api/uploads/already-saved.png');expect(row().cost).toBe(2);
 resumeSpecificationTasks();expect(db.select().from(users).where(eq(users.id,userId)).get()!.balance).toBe(98);
});
it('does not discard a candidate with a missing URL or charge for a partial batch',async()=>{
 let ready=false;const f=vi.fn(async(url:any,opts:any)=>{
  if(opts?.method==='POST')return Response.json({task_id:'original-image',status:'completed',data:[{url:'https://cdn.test/1.png'},{}]});
  if(String(url).includes('/tasks/'))return ready ? completed() : Response.json({task_id:'original-image',status:'completed',data:[]});
  return new Response(png);
 });vi.stubGlobal('fetch',f);await submit();expect(row().status).toBe('processing');expect(meta().upstreamGenerated).toBe(true);
 expect(meta().resultSaveError).toContain('第 2 张');expect(meta().billingStatus).toBe('reserved');expect(meta().imageUrls).toHaveLength(0);
 ready=true;await vi.advanceTimersByTimeAsync(31000);await vi.waitFor(()=>expect(row().status).toBe('completed'));expect(meta().imageUrls).toHaveLength(2);
});
it('recognizes generated but upstream storage-pending as delivery, not a new generation',async()=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task_id:'original-image',status:'completed',storage_status:'pending'})));
 await submit();expect(meta().upstreamGenerated).toBe(true);expect(meta().progressText).toContain('等待上游保存');
 expect(meta().requiresReview).not.toBe(true);expect(meta().billingStatus).toBe('reserved');
});
it('rejects a query without status instead of silently assuming queued',()=>{
 expect(()=>normalizeHussImage({task_id:'x'},'x')).toThrow('未识别状态');
 expect(normalizeHussImage({task_id:'x'}).status).toBe('queued');
});

it('propagates local disk write failure instead of treating a data URL as a saved result',async()=>{
 const fs=await import('node:fs');
 const actual=await vi.importActual<typeof import('../server/routes/imageGen.js')>('../server/routes/imageGen.js');
 const write=vi.spyOn(fs.default,'writeFileSync').mockImplementation(()=>{throw new Error('ENOSPC test disk full');});
 try {
  await expect(actual.localizeGeneratedImage('data:image/png;base64,'+png.toString('base64'),'huss-test', {protocol:'https',headers:{},get:()=> 'local.test'} as any,channel,{relative:true})).rejects.toThrow('ENOSPC test disk full');
 } finally {write.mockRestore();}
});

it('saves a real image with a restart recovery request lacking HTTP headers',async()=>{
 const fs=await import('node:fs');const path=await import('node:path');
 const actual=await vi.importActual<typeof import('../server/routes/imageGen.js')>('../server/routes/imageGen.js');
 const url=await actual.localizeGeneratedImage('data:image/png;base64,'+png.toString('base64'),'huss-restart-test',{protocol:'https',get:()=> 'local.test'} as any,channel,{relative:true});
 expect(url).toMatch(/^\/api\/uploads\/huss-restart-test_/);
 const file=path.resolve('data/uploads',path.basename(url));
 try {expect(fs.readFileSync(file)).toEqual(png);} finally {fs.unlinkSync(file);}
});
