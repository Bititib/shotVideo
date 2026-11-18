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
vi.mock('../server/services/channelService.js',()=>({ChannelService:{findChannelsForModel:()=>[{id:1,type:'image2pro',baseUrl:'https://api.image2pro.top/v1',apiKey:'fake',modelMapping:{}}],findChannelForModel:()=>({id:1,type:'image2pro',baseUrl:'https://api.image2pro.top/v1',apiKey:'fake',modelMapping:{},timeout:1000})}}));
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

it('normal chat uses one v1, stable saved reservation ID and settles usage',async()=>{
 const f=vi.fn(async(url:any,init:any)=>{expect(url).toBe('https://api.image2pro.top/v1/chat/completions');expect(init.headers['Idempotency-Key']).toBe(records()[0].id);return Response.json({choices:[{message:{content:'你好'}}],usage:{prompt_tokens:10,completion_tokens:20}});});vi.stubGlobal('fetch',f);
 const res=await invoke(apiRouter,'/chat/completions',{model:'test-chat',messages:[{role:'user',content:'hello'}]});expect(res.body.choices[0].message.content).toBe('你好');expect(records()[0].state).toBe('settled');expect(f).toHaveBeenCalledOnce();
});
it.each([400,401,402,429])('refunds explicit text rejection %s once',async status=>{
 vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:{message:'具体拒绝 fake',code:'denied',type:'invalid_request_error'}},{status})));
 const res=await invoke(apiRouter,'/chat/completions',{model:'test-chat',messages:[{role:'user',content:'hi'}]});expect(res.code).toBe(status);expect(res.body.error.message).toContain('具体拒绝');expect(res.body.error.message).not.toContain('fake');expect(tokenBalance()).toBe(100);expect(records()[0].state).toBe('refunded');
});
it('holds unknown submission without retry or refund',async()=>{
 const f=vi.fn(async()=>{throw new Error('disconnect');});vi.stubGlobal('fetch',f);await invoke(apiRouter,'/chat/completions',{model:'test-chat',messages:[{role:'user',content:'hi'}]});expect(records()[0].state).toBe('review');expect(f).toHaveBeenCalledOnce();
});
it.each([true,false])('requires a complete stream terminator (%s)',async complete=>{
 const chunks='data: '+JSON.stringify({choices:[{delta:{content:'hello'}}]})+'\n\ndata: '+JSON.stringify({choices:[],usage:{prompt_tokens:10,completion_tokens:20}})+'\n\n'+(complete?'data: [DONE]\n\n':'');
 vi.stubGlobal('fetch',vi.fn(async()=>new Response(chunks,{headers:{'Content-Type':'text/event-stream'}})));
 const res=await invoke(apiRouter,'/chat/completions',{model:'test-chat',messages:[{role:'user',content:'hi'}],stream:true});expect(res.chunks.join('')).toContain('hello');expect(records()[0].state).toBe(complete?'settled':'review');
});
it('rejects multiple choices before submitting or charging',async()=>{const f=vi.fn();vi.stubGlobal('fetch',f);const res=await invoke(apiRouter,'/chat/completions',{model:'test-chat',messages:[{role:'user',content:'hi'}],n:2});expect(res.code).toBe(400);expect(f).not.toHaveBeenCalled();expect(tokenBalance()).toBe(100);});

it('does not settle an SSE error carrying usage and DONE',async()=>{vi.stubGlobal('fetch',vi.fn(async()=>new Response('data: '+JSON.stringify({error:{message:'quota fake'},usage:{prompt_tokens:1,completion_tokens:1}})+'\n\ndata: [DONE]\n\n')));const res=await invoke(apiRouter,'/chat/completions',{model:'test-chat',messages:[{role:'user',content:'hi'}],stream:true});expect(records()[0].state).toBe('review');expect(res.chunks.join('')).not.toContain('fake');});

it('preserves multi-turn vision, sampling, structured output and tool calls',async()=>{
 sqlite.exec('UPDATE api_tokens SET balance=1000 WHERE id=1');
 const messages=[{role:'system',content:'Be concise'},{role:'user',content:[{type:'text',text:'Describe it'},{type:'image_url',image_url:{url:'https://assets.test/a.png'}}]},{role:'assistant',content:'A cup'},{role:'user',content:'Find its price'}];
 const tools=[{type:'function',function:{name:'price',parameters:{type:'object',properties:{}}}}];
 const f=vi.fn(async(_url:any,init:any)=>{expect(JSON.parse(init.body)).toMatchObject({messages,tools,tool_choice:'auto',temperature:0.4,top_p:0.8,max_completion_tokens:128,response_format:{type:'json_object'}});return Response.json({choices:[{message:{content:null,tool_calls:[{id:'call1',type:'function',function:{name:'price',arguments:'{}'}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:10,completion_tokens:20}});});vi.stubGlobal('fetch',f);
 const res=await invoke(apiRouter,'/chat/completions',{model:'test-chat',messages,tools,tool_choice:'auto',temperature:0.4,top_p:0.8,max_completion_tokens:128,response_format:{type:'json_object'}});
 expect(res.body.choices[0].finish_reason).toBe('tool_calls');expect(records()[0].state).toBe('settled');expect(f).toHaveBeenCalledOnce();
});
it.each([{temperature:3},{top_p:-1},{frequency_penalty:3},{seed:1.5},{stop:['a','b','c','d','e']},{response_format:{type:'unknown'}}])('rejects invalid text parameters without submission or deduction: %j',async params=>{
 const f=vi.fn();vi.stubGlobal('fetch',f);const res=await invoke(apiRouter,'/chat/completions',{model:'test-chat',messages:[{role:'user',content:'hi'}],...params});expect(res.code).toBe(400);expect(f).not.toHaveBeenCalled();expect(tokenBalance()).toBe(100);
});
