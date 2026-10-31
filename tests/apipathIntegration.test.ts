vi.mock('../server/routes/imageGen.js', () => ({ localizeGeneratedImage: vi.fn(async () => '/uploads/apipath.png') }));
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/services/videoLocalizationService.js', () => ({ downloadAndLocalizeVideo: vi.fn(async () => '/uploads/async-video-result.mp4') }));
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../server/db/index.js';
import { channels, contents, models, modelPricing, settings, users } from '../server/db/schema.js';
import { ChannelService } from '../server/services/channelService.js';
import { getModelSpecification, saveModelSpecification } from '../server/services/modelRoutingService.js';
import { handleSpecificationGeneration, resumeSpecificationTasks } from '../server/services/specificationGenerationService.js';
import { VideoRecoveryService } from '../server/services/videoRecoveryService.js';
import { downloadAndLocalizeVideo } from '../server/services/videoLocalizationService.js';
import * as referenceValidation from '../server/services/imageReferenceValidationService.js';

const key = 'private-apipath-key';
let channelId: number, modelId: string;
const discovery = () => Response.json({ data: [{ id: 'seedance-2.0-YZ' }, { id: 'gpt-image-2-5-flare' }] });
const response = () => {
  const res: any = { headersSent: false, writableEnded: false, destroyed: false };
  res.status = vi.fn(code => { res.statusCode = code; return res; }); res.json = vi.fn(body => { res.body = body; return res; });
  res.setHeader = vi.fn(); res.flushHeaders = vi.fn(() => { res.headersSent = true; }); res.write = vi.fn();
  res.end = vi.fn(() => { res.writableEnded = true; }); return res;
};
const request = (body: Record<string, unknown> = {}) => ({ userId: 1, headers: {}, protocol: 'https', get: () => 'app.example',
  body: { model: modelId, prompt: '海浪拍打礁石', seconds: 10, resolution: '720p', aspect_ratio: '9:16', ...body } } as any);

beforeEach(async () => {
  if (sqlite.prepare("SELECT name FROM sqlite_master WHERE name='video_submission_receipts'").get()) sqlite.exec('DELETE FROM video_submission_receipts');
  vi.clearAllMocks();
  db.delete(contents).run(); db.delete(settings).run(); db.delete(models).run(); db.delete(channels).run(); db.delete(modelPricing).run(); db.delete(users).run();
  db.insert(users).values({ id: 1, email: 'async@test.invalid', username: 'test', passwordHash: 'test', balance: 100 }).run();
  vi.stubGlobal('fetch', vi.fn(async () => discovery()));
  channelId = ChannelService.createChannel({ name: '通联测试', type: 'apipath', baseUrl: 'http://provider.invalid:8080/v1/', apiKey: key });
  await ChannelService.syncModels(channelId); modelId = 'seedance-2.0-YZ';
});
afterEach(() => vi.unstubAllGlobals());
afterAll(() => sqlite.close());
function enable() {
  db.update(models).set({ isActive: 1 }).where(eq(models.modelId, modelId)).run();
  db.insert(modelPricing).values({ modelPattern: modelId, billingType: 'per_call', inputPrice: 2, outputPrice: 0 }).run();
}


describe('通联 actual specification entry and isolated billing', () => {
  it.each(['completed','failed'])('settles %s and persists the receipt before GET', async status => {
    enable(); vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      if(init?.method==='POST') return Response.json({task_no:'task_1',status:'queued'});
      const meta=JSON.parse(db.select().from(contents).all().at(-1)!.metadata);
      expect(meta.videoId).toBe('task_1');
      return Response.json({task_no:'task_1',status,url:'https://cdn.example/result.mp4',error:status==='failed'?{code:'render_failed',message:'具体渲染原因'}:null});
    }));
    await handleSpecificationGeneration(request(),response(),'video');
    expect(db.select().from(contents).all().at(-1)).toMatchObject({status,cost:status==='completed'?2:0});
    expect(db.select().from(users).all()[0].balance).toBe(status==='completed'?98:100);
    resumeSpecificationTasks(); expect(db.select().from(users).all()[0].balance).toBe(status==='completed'?98:100);
  });
  it.each([400,401])('refunds documented rejection %s exactly once',async status=>{
    enable();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:{code:status===400?'invalid_request_error':'invalid_api_key',message:'真实拒绝原因'}},{status})));
    await handleSpecificationGeneration(request(),response(),'video');
    const row=db.select().from(contents).all().at(-1)!;expect(row.status).toBe('failed');
    expect(JSON.parse(row.metadata).requiresReview).not.toBe(true);expect(row.metadata).toContain('真实拒绝原因');
    expect(db.select().from(users).all()[0].balance).toBe(100);resumeSpecificationTasks();expect(fetch).toHaveBeenCalledOnce();
    expect(db.select().from(users).all()[0].balance).toBe(100);
  });
  it.each(['disconnect','missing','html','upstream'])('holds unknown %s without replay or refund',async kind=>{
    enable();vi.stubGlobal('fetch',vi.fn(async()=>{if(kind==='disconnect')throw new Error('socket closed');if(kind==='html')return new Response('<html>gateway</html>',{status:502});return Response.json(kind==='missing'?{}:{error:{code:'upstream_error',message:'服务异常'}},{status:kind==='upstream'?502:200});}));
    await handleSpecificationGeneration(request(),response(),'video');resumeSpecificationTasks();
    expect(fetch).toHaveBeenCalledOnce();expect(db.select().from(users).all()[0].balance).toBe(98);
    expect(JSON.parse(db.select().from(contents).all().at(-1)!.metadata)).toMatchObject({requiresReview:true});
  });
  it('honors immediate failed task without querying or losing its ID',async()=>{
    enable();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task_no:'failed_1',status:'failed',error:{message:'立即失败'}})));
    await handleSpecificationGeneration(request(),response(),'video');expect(fetch).toHaveBeenCalledOnce();
    const row=db.select().from(contents).all().at(-1)!;expect(row.status).toBe('failed');expect(JSON.parse(row.metadata).videoId).toBe('failed_1');expect(db.select().from(users).all()[0].balance).toBe(100);
  });
  it('resumes original video with GET only',async()=>{
    const id=Number(db.insert(contents).values({userId:1,type:'video',modelId,status:'processing',metadata:JSON.stringify({managedSpecification:true,channelId,videoId:'original',actualModel:modelId,requestedModel:modelId})}).run().lastInsertRowid);
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task_no:'original',status:'completed',url:'https://cdn.example/video.mp4'})));
    expect(await VideoRecoveryService.inspect(id)).toMatchObject({status:'completed'});resumeSpecificationTasks();
    await vi.waitFor(()=>expect(db.select().from(contents).where(eq(contents.id,id)).get()?.status).toBe('completed'));
    expect(vi.mocked(fetch).mock.calls.every(c=>c[1]?.method==='GET')).toBe(true);
  });
  it('generates an image through the charged website entry',async()=>{
    modelId='gpt-image-2-5-flare';enable();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({created:1,data:[{url:'https://cdn.example/image.png'}]})));
    const res=response();await handleSpecificationGeneration(request({resolution:'default'}),res,'image');
    expect(db.select().from(contents).all().at(-1),JSON.stringify(res.body)).toMatchObject({status:'completed',cost:2});
    const [url,init]=vi.mocked(fetch).mock.calls[0];expect(String(url)).toContain('/v1/images/generations');expect(JSON.parse(String(init?.body))).toMatchObject({model:modelId,n:1});
  });
  it('imports disabled and preserves prices and administrator switches',async()=>{
    expect(db.select().from(models).all().every(x=>x.isActive===0)).toBe(true);enable();const spec=getModelSpecification(modelId)!;spec.routes[0].enabled=false;saveModelSpecification(spec);
    await ChannelService.syncModels(channelId);expect(getModelSpecification(modelId)?.routes[0].enabled).toBe(false);expect(db.select().from(modelPricing).all()[0].inputPrice).toBe(2);
    expect(ChannelService.getChannelRaw(channelId)?.maxRetries).toBe(0);
  });
  it('retries a query failure without repeating the paid submission',async()=>{
    enable();vi.useFakeTimers();let queries=0;
    vi.stubGlobal('fetch',vi.fn(async (_url:any,init:any)=>init?.method==='POST'?Response.json({task_no:'q1',status:'queued'}):++queries===1?Response.json({error:{code:'upstream_error',message:'临时查询异常'}},{status:502}):Response.json({task_no:'q1',status:'completed',url:'https://cdn.example/video.mp4'})));
    try {const work=handleSpecificationGeneration(request(),response(),'video');await vi.advanceTimersByTimeAsync(13000);await work;
      expect(vi.mocked(fetch).mock.calls.filter(c=>c[1]?.method==='POST')).toHaveLength(1);
      expect(db.select().from(contents).all().at(-1)?.status).toBe('completed');expect(db.select().from(users).all()[0].balance).toBe(98);
    }finally{vi.useRealTimers();}
  });
  it('keeps the completed receipt when saving fails and never generates again',async()=>{
    enable();vi.useFakeTimers();vi.mocked(downloadAndLocalizeVideo).mockRejectedValueOnce(new Error('disk temporarily unavailable'));
    vi.stubGlobal('fetch',vi.fn(async (_url:any,init:any)=>Response.json(init?.method==='POST'?{task_no:'save1',status:'queued'}:{task_no:'save1',status:'completed',url:'https://cdn.example/video.mp4'})));
    try {const work=handleSpecificationGeneration(request(),response(),'video');await vi.advanceTimersByTimeAsync(9000);await work;
      expect(fetch).toHaveBeenCalledTimes(2);expect(downloadAndLocalizeVideo).toHaveBeenCalledTimes(2);expect(db.select().from(users).all()[0].balance).toBe(98);
    }finally{vi.useRealTimers();}
  });
  it('uses multipart edits with all validated reference bytes',async()=>{
    modelId='gpt-image-2-5-flare';enable();const validation=vi.spyOn(referenceValidation,'validateAndNormalizeImageReferences').mockResolvedValue(['data:image/png;base64,aGVsbG8=']);
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{url:'https://cdn.example/edited.png'}]})));
    try{await handleSpecificationGeneration(request({resolution:'default',reference_images:['https://images.example/ref.png']}),response(),'image');
      const [url,init]=vi.mocked(fetch).mock.calls[0];expect(String(url)).toContain('/v1/images/edits');expect(init?.body).toBeInstanceOf(FormData);expect((init?.body as FormData).getAll('image[]')).toHaveLength(1);
      expect(db.select().from(contents).all().at(-1)?.status).toBe('completed');
    }finally{validation.mockRestore();}
  });
  it('preserves accepted ID even when HTTP error accompanies the receipt',async()=>{
    enable();vi.stubGlobal('fetch',vi.fn(async()=>Response.json({task_no:'accepted',status:'processing',error:{code:'upstream_error',message:'网关异常'}},{status:502})));
    await handleSpecificationGeneration(request(),response(),'video');const meta=JSON.parse(db.select().from(contents).all().at(-1)!.metadata);
    expect(meta).toMatchObject({videoId:'accepted',requiresReview:true});expect(db.select().from(users).all()[0].balance).toBe(98);expect(fetch).toHaveBeenCalledOnce();
  });

});
