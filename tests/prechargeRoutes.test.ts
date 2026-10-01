import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const { getTableConfig } = await import('drizzle-orm/sqlite-core');
  const schema = await import('../server/db/schema.js');
  const sqlite = new Database(':memory:');
  for (const table of Object.values(schema)) {
    try {
      const config=getTableConfig(table as any);
      sqlite.exec(`CREATE TABLE IF NOT EXISTS "${config.name}" (${config.columns.map(c=>`"${c.name}" ${c.getSQLType()}${c.primary?' PRIMARY KEY':''}`).join(',')})`);
    } catch { /* relation exports are not tables */ }
  }
  return {sqlite,db:drizzle(sqlite,{schema})};
});
vi.mock('../server/routes/video.js',()=>({ enqueueHmStudioVideoContent:vi.fn(),resumePollForTask:vi.fn(),holdHayaSubmission:vi.fn(),releaseHayaSubmission:vi.fn() }));
vi.mock('../server/services/channelService.js',()=>({ChannelService:{findChannelsForModel:()=>[{id:1,type:'openai',baseUrl:'https://mock.invalid',apiKey:'fake',modelMapping:{}}],findChannelForModel:()=>({id:1,type:'openai',baseUrl:'https://mock.invalid',apiKey:'fake',modelMapping:{},timeout:1000})}}));
vi.mock('../server/services/pricingService.js',()=>({PricingService:{quote:(_model:string,params:any)=>({cost:(params.count || 1)*2}),createQuoteResolver:()=> (_model:string,usage:any)=>({cost:(usage.promptTokens+usage.completionTokens)/1000}),calculateCost:(_model:string,input:number,output:number)=>(input+output)/1000}}));
vi.mock('../server/services/aiService.js',()=>({AIService:{generateTts:vi.fn(),generateImage:vi.fn(),getTtsVoiceCatalog:vi.fn(),clonedVoices:vi.fn()}}));
vi.mock('../server/middleware/quota.js',()=>({quotaMiddleware:vi.fn(),logUsage:vi.fn()}));
vi.mock('../server/services/comicDramaQueueService.js',()=>({ComicDramaQueueService:{}}));
vi.mock('../server/services/comicDramaAnalysisQueueService.js',()=>({ComicDramaAnalysisQueueService:{}}));
import { sqlite } from '../server/db/index.js';
import apiRouter from '../server/routes/v1.js';
import analysisRouter from '../server/routes/analysis.js';
import imageRouter from '../server/routes/imageGen.js';
import { AIService } from '../server/services/aiService.js';

function response() {
  const res:any={code:200,headers:{},chunks:[],headersSent:false};
  res.status=(code:number)=>{res.code=code;return res;};
  res.json=(body:any)=>{res.body=body;return res;};
  res.setHeader=(name:string,value:any)=>{res.headers[name]=value;};
  res.write=(chunk:string)=>{res.headersSent=true;res.chunks.push(chunk);};
  res.flushHeaders=()=>{};res.end=()=>{res.ended=true;};return res;
}
async function invoke(router:any,path:string,body:any) {
  const layer=router.stack.find((layer:any)=>layer.route?.path===path&&layer.route.methods.post);
  const req:any={body,userId:1,protocol:'http',get:()=> 'localhost',headers:{authorization:'Bearer test-only'},socket:{},
    availableModels:[{id:1,modelId:'test-tts'},{id:2,modelId:'test-image'}]};
  const res=response();await layer.route.stack.at(-1).handle(req,res,()=>{});return res;
}
const tokenBalance=()=> (sqlite.prepare('SELECT balance FROM api_tokens WHERE id=1').get() as any).balance;
const userBalance=()=> (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
const records=()=>sqlite.prepare('SELECT * FROM billing_reservations').all() as any[];
beforeEach(()=>{
  sqlite.exec(`DELETE FROM api_tokens;DELETE FROM users;DELETE FROM contents;DELETE FROM api_logs;DROP TABLE IF EXISTS billing_reservations;
    INSERT INTO api_tokens(id,name,token_key,allowed_models,balance,used_amount,status) VALUES(1,'test','test-only','[]',100,0,1);
    INSERT INTO users(id,balance) VALUES(1,100);`);
});
afterEach(()=>{vi.unstubAllGlobals();vi.clearAllMocks();});
describe('route precharge order and refunds without paid providers',()=>{
  it('falls back only on an explicit invalid clone and settles once', async () => {
    vi.mocked(AIService.clonedVoices).mockReturnValue({ requireVoice: vi.fn() } as any);
    vi.mocked(AIService.getTtsVoiceCatalog).mockResolvedValue([{ id: 'Zephyr', name: 'Zephyr' }]);
    vi.mocked(AIService.generateTts).mockRejectedValueOnce(Object.assign(new Error('Voice not found'), { upstreamStatus: 404 })).mockResolvedValueOnce({ audioBase64: 'test', mimeType: 'audio/wav' });
    const res = await invoke(analysisRouter, '/generate-tts', { text: 'hello', voice: 'voices/voice_123' });
    expect(res.body.usedVoice).toBe('Zephyr');
    expect(res.body.warning).toContain('失效');
    expect(AIService.generateTts).toHaveBeenCalledTimes(2);
    expect(userBalance()).toBe(98);
    expect(records()).toHaveLength(1);
  });
  it('does not replace a clone when the model itself returns 404', async () => {
    vi.mocked(AIService.clonedVoices).mockReturnValue({ requireVoice: vi.fn() } as any);
    vi.mocked(AIService.generateTts).mockRejectedValueOnce(Object.assign(new Error('Model not found'), { upstreamStatus: 404 }));
    await invoke(analysisRouter, '/generate-tts', { text: 'hello', voice: 'voices/voice_123' });
    expect(AIService.generateTts).toHaveBeenCalledTimes(1);
    expect(userBalance()).toBe(100);
  });
  it('lists only registered TTS models with their upstream voices', async () => {
    sqlite.exec(`DELETE FROM models;
      INSERT INTO models(id,model_id,display_name,capabilities,is_active) VALUES
      (1,'old-tts','Old TTS','["tts"]',1),
      (2,'gemini-3.8-flash-tts','Gemini 3.8','["tts"]',1),
      (3,'disabled-tts','Disabled','["tts"]',0);`);
    vi.mocked(AIService.getTtsVoiceCatalog).mockResolvedValue([{id:'NewVoice',name:'NewVoice',description:'测试音色'}]);
    const layer = analysisRouter.stack.find((layer: any) => layer.route?.path === '/tts-models') as any;
    const res = response(); const next = vi.fn();
    await layer.route.stack.at(-1).handle({}, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.body.map((m: any) => m.modelId)).toEqual(['old-tts', 'gemini-3.8-flash-tts']);
    expect(res.body[1].voices).toEqual(['NewVoice']);
    expect(res.body[0].voices).toEqual(['NewVoice']);
    expect(res.body[0].voiceSource).toBe('upstream');
    expect(res.body[1].voiceDetails[0].description).toBe('测试音色');
    sqlite.exec('DELETE FROM models');
  });
  it('website image generation precharges and refunds failed asynchronous jobs',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{expect(userBalance()).toBe(96);return new Response('failed',{status:500});}));
    const res=await invoke(imageRouter,'/generate',{model:'gpt-image-test',prompt:'test',n:2});
    await vi.waitFor(()=>expect(res.ended).toBe(true));
    expect(userBalance()).toBe(100);expect(records()[0].state).toBe('refunded');
  });
  it('website image generation only charges the successful half',async()=>{
    let calls=0;
    vi.stubGlobal('fetch',vi.fn(async()=>{
      expect(userBalance()).toBe(96);
      return ++calls===1?Response.json({data:[{url:'http://localhost/uploads/test.png'}]}):new Response('failed',{status:500});
    }));
    const res=await invoke(imageRouter,'/generate',{model:'gpt-image-test',prompt:'test',n:2});
    await vi.waitFor(()=>expect(res.ended).toBe(true));
    expect(userBalance()).toBe(98);expect(records()[0].actual).toBe(2);
  });
  it('API images precharge before fetch and refund the missing image',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{
      expect(tokenBalance()).toBe(96);return Response.json({data:[{url:'https://mock.invalid/image.png'}]});
    }));
    const res=await invoke(apiRouter,'/images/generations',{model:'test-image',prompt:'test',n:2});
    expect(res.code).toBe(200);expect(tokenBalance()).toBe(98);expect(records()[0].state).toBe('settled');
  });
  it.each([false,true])('API images refund upstream failure/empty success (%s)',async empty=>{
    vi.stubGlobal('fetch',vi.fn(async()=>empty?Response.json({data:[]}):new Response('failed',{status:500})));
    const res=await invoke(apiRouter,'/images/generations',{model:'test-image',prompt:'test'});
    expect(res.code).toBeGreaterThanOrEqual(500);expect(tokenBalance()).toBe(100);expect(records()[0].state).toBe('refunded');
  });
  it('insufficient API funds prevent any upstream request',async()=>{
    sqlite.exec('UPDATE api_tokens SET balance=1');const fetch=vi.fn();vi.stubGlobal('fetch',fetch);
    const res=await invoke(apiRouter,'/images/generations',{model:'test-image',prompt:'test'});
    expect(res.code).toBe(402);expect(fetch).not.toHaveBeenCalled();expect(tokenBalance()).toBe(1);
  });
  it('chat settles real usage and releases the unused reservation',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>{
      expect(tokenBalance()).toBeLessThan(99);return Response.json({choices:[{message:{content:'ok'}}],usage:{prompt_tokens:10,completion_tokens:20}});
    }));
    const res=await invoke(apiRouter,'/chat/completions',{model:'test-chat',messages:[{role:'user',content:'test'}]});
    expect(res.code).toBe(200);expect(tokenBalance()).toBeCloseTo(99.97);expect(records()[0].actual).toBeCloseTo(0.03);
  });
  it('stream usage survives JSON split across arbitrary network chunks',async()=>{
    const parts=['data: {"choices":[]}\n\n','data: {"usa','ge":{"prompt_tokens":10,"completion_tokens":20}}\n\ndata: [DONE]\n\n'];
    vi.stubGlobal('fetch',vi.fn(async()=>new Response(new ReadableStream({start(controller){for(const part of parts)controller.enqueue(new TextEncoder().encode(part));controller.close();}}))));
    const res=await invoke(apiRouter,'/chat/completions',{model:'test-chat',messages:[],stream:true});
    expect(res.ended).toBe(true);expect(tokenBalance()).toBeCloseTo(99.97);expect(records()[0].state).toBe('settled');
  });
  it('missing chat usage remains explicitly pending review',async()=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({choices:[{message:{content:'ok'}}]})));
    const res=await invoke(apiRouter,'/chat/completions',{model:'test-chat',messages:[]});
    expect(res.headers['X-Billing-Status']).toBe('review');expect(records()[0].actual).toBeNull();
    expect(records()[0].state).toBe('review');
  });
  it('rejects an unavailable requested TTS model without charging or substituting a model', async () => {
    const res = await invoke(analysisRouter, '/generate-tts', { text: 'hello', voice: 'Kore', modelId: 'unavailable-tts' });
    expect(res.code).toBe(403); expect(AIService.generateTts).not.toHaveBeenCalled(); expect(userBalance()).toBe(100);
  });
  it('TTS precharges before provider invocation and settles on success',async()=>{
    vi.mocked(AIService.generateTts).mockImplementation(async()=>{expect(userBalance()).toBe(98);return {audioBase64:'test',mimeType:'audio/wav'};});
    const res=await invoke(analysisRouter,'/generate-tts',{text:'hello',voice:'test'});
    expect(res.code).toBe(200);expect(userBalance()).toBe(98);expect(records()[0].state).toBe('settled');
  });
  it('TTS provider failure refunds',async()=>{
    vi.mocked(AIService.generateTts).mockRejectedValue(new Error('provider failed'));
    const res=await invoke(analysisRouter,'/generate-tts',{text:'hello',voice:'test'});
    expect(res.code).toBe(500);expect(userBalance()).toBe(100);expect(records()[0].state).toBe('refunded');
  });
  it('TTS insufficient balance stops before the provider',async()=>{
    sqlite.exec('UPDATE users SET balance=1');
    const res=await invoke(analysisRouter,'/generate-tts',{text:'hello',voice:'test'});
    expect(res.code).toBe(402);expect(AIService.generateTts).not.toHaveBeenCalled();expect(userBalance()).toBe(1);
  });
  it('legacy image generation also precharges and refunds on failure',async()=>{
    vi.mocked(AIService.generateImage).mockImplementation(async()=>{expect(userBalance()).toBe(98);throw new Error('provider failed');});
    const res=await invoke(analysisRouter,'/generate-image',{prompt:'test'});
    expect(res.code).toBe(500);expect(userBalance()).toBe(100);expect(records()[0].state).toBe('refunded');
  });
});
