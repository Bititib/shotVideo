import { beforeAll, beforeEach, afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
vi.mock('../server/db/index.js',async()=>(await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db, sqlite } from '../server/db/index.js';
import { users, apiTokens, organizations } from '../server/db/schema.js';
import { ContentService } from '../server/services/contentService.js';
import { ChannelService } from '../server/services/channelService.js';
import { saveMinikeyModelConfiguration } from '../server/services/minikeyModelConfigurationService.js';
import { blankMinikeyModel } from '../shared/minikeyModelConfiguration.js';
import { createMusicTask,processMusicTask,resumeMusicTasks,ensureMusicJobs,getMusicTask,listMusicTasks,musicFile } from '../server/services/musicGenerationService.js';
import { getEnabledPublicModels } from '../server/services/modelCatalogService.js';
import { TokenService } from '../server/services/tokenService.js';
import { reserveCharge } from '../server/services/billingReservation.js';
import v1Router from '../server/routes/v1.js';
import musicRouter from '../server/routes/music.js';
import { resolveBillingReservation } from '../server/services/billingReconciliation.js';

const upstream='a'.repeat(32),owner={userId:1};let channelId:number;
const input=()=>({model:'my-song',prompt:'海边的民谣',client_request_id:'request_123',mode:'song',tags:['民谣']});
const balance=()=> (sqlite.prepare('SELECT balance FROM users WHERE id=1').get() as any).balance;
const row=(id:string)=>sqlite.prepare('SELECT * FROM music_jobs WHERE id=?').get(id) as any;
const due=()=>sqlite.prepare('UPDATE music_jobs SET next_poll=0,lease_until=0').run();
beforeAll(()=>ensureMusicJobs());
beforeEach(async()=>{
  sqlite.exec('SAVEPOINT music_test');
  db.insert(users).values({id:1,email:'music@test.invalid',username:'music',passwordHash:'test',balance:100}).run();
  channelId=ChannelService.createChannel({name:'miniKey',type:'minikey',baseUrl:'https://minikey.work',apiKey:'mk_secret'});
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({models:[{model:'suno-v6',category:'audio',channels:[{id:22,name:'line'}]}]})));
  await saveMinikeyModelConfiguration(channelId,{...blankMinikeyModel(),kind:'music',modelId:'my-song',upstreamModel:'suno-v6',upstreamChannel:22},null);
  sqlite.prepare("UPDATE models SET is_active=1 WHERE model_id='my-song'").run();
  sqlite.prepare("INSERT INTO model_pricing(model_pattern,billing_type,input_price) VALUES('my-song','per_call',2)").run();
  vi.mocked(fetch).mockClear();
});
afterEach(async()=>{
  for(const r of sqlite.prepare('SELECT id FROM music_jobs').all() as any[])await fs.rm('data/uploads/music/'+r.id+'.mp3',{force:true});
  vi.unstubAllGlobals();vi.restoreAllMocks();sqlite.exec('ROLLBACK TO music_test; RELEASE music_test');
});
it('admin-configured model executes, persists original ID before querying, saves MP3 and settles exactly once',async()=>{
  expect(getEnabledPublicModels('music',1).map(m=>m.modelId)).toEqual(['my-song']);
  const task=createMusicTask(input(),owner);
  vi.mocked(fetch).mockImplementation(async(url,init)=>{
    if(init?.method==='POST'){expect(row(task.id).state).toBe('submitting');expect(balance()).toBe(98);expect(JSON.parse(init.body as string)).toMatchObject({model:'suno-v6',chan:22});return Response.json({id:upstream,status:'queued'});}
    expect(row(task.id).upstream_id).toBe(upstream);
    if(String(url).endsWith('/file'))return new Response(Buffer.from('ID3 music-test'),{headers:{'Content-Type':'audio/mpeg'}});
    return Response.json({id:upstream,status:'success',musicUrl:'https://cdn.example/music.mp3'});
  });
  await Promise.all([processMusicTask(task.id),processMusicTask(task.id)]);
  expect(getMusicTask(task.id,owner)).toMatchObject({status:'completed',cost:2,result_url:'/uploads/music/'+task.id+'.mp3'});
  expect(await fs.readFile(musicFile(task.id,owner),'utf8')).toBe('ID3 music-test');
  await resumeMusicTasks();expect(balance()).toBe(98);
  expect(vi.mocked(fetch).mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(1);
  expect(createMusicTask(input(),owner).id).toBe(task.id);expect(balance()).toBe(98);
});
it('explicit rejection refunds once; uncertain submission and interrupted sending never replay',async()=>{
  vi.mocked(fetch).mockResolvedValue(Response.json({detail:'积分不足'},{status:402}));
  const failed=createMusicTask(input(),owner);await processMusicTask(failed.id);await resumeMusicTasks();
  expect(getMusicTask(failed.id,owner)).toMatchObject({status:'failed',cost:0,error:expect.stringContaining('积分不足')});expect(balance()).toBe(100);
  vi.mocked(fetch).mockRejectedValue(new Error('connection reset'));
  const uncertain=createMusicTask({...input(),client_request_id:'request_456'},owner);await processMusicTask(uncertain.id);due();await resumeMusicTasks();
  expect(getMusicTask(uncertain.id,owner).status).toBe('review');expect(balance()).toBe(98);
  const interrupted=createMusicTask({...input(),client_request_id:'request_789'},owner);
  sqlite.prepare("UPDATE music_jobs SET state='submitting' WHERE id=?").run(interrupted.id);
  await processMusicTask(interrupted.id);expect(getMusicTask(interrupted.id,owner).status).toBe('review');
  expect(fetch).toHaveBeenCalledTimes(2);expect(balance()).toBe(96);
});
it('query failures keep funds, restart polls original task, explicit failure refunds once',async()=>{
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({id:upstream,status:'queued'},{status:500})).mockResolvedValueOnce(Response.json({detail:'临时不可用'},{status:503}));
  const task=createMusicTask(input(),owner);await processMusicTask(task.id);
  expect(row(task.id).upstream_id).toBe(upstream);expect(balance()).toBe(98);expect(getMusicTask(task.id,owner).status).toBe('review');
  vi.mocked(fetch).mockResolvedValue(Response.json({id:upstream,status:'processing',progress:85,error:'delivery pending'}));due();await resumeMusicTasks();
  expect(getMusicTask(task.id,owner).status).toBe('processing');expect(balance()).toBe(98);
  vi.mocked(fetch).mockResolvedValue(Response.json({id:upstream,status:'failed',error:'歌词内容拒绝'}));due();await resumeMusicTasks();await resumeMusicTasks();
  expect(getMusicTask(task.id,owner)).toMatchObject({status:'failed',error:expect.stringContaining('歌词内容拒绝')});expect(balance()).toBe(100);
  expect(vi.mocked(fetch).mock.calls.filter(([,i])=>i?.method==='POST')).toHaveLength(1);
});
it('invalid files stay recoverable and changed credentials cannot query another account',async()=>{
  const task=createMusicTask(input(),owner);
  vi.mocked(fetch).mockImplementation(async(url,init)=>init?.method==='POST'?Response.json({id:upstream,status:'queued'}):String(url).endsWith('/file')?new Response('<html>error</html>'):Response.json({id:upstream,status:'success',musicUrl:'https://cdn.example/a.mp3'}));
  await processMusicTask(task.id);expect(getMusicTask(task.id,owner)).toMatchObject({status:'review',error:expect.stringContaining('MP3')});expect(balance()).toBe(98);
  sqlite.prepare('UPDATE channels SET api_key=? WHERE id=?').run('changed',channelId);vi.mocked(fetch).mockClear();due();await resumeMusicTasks();expect(fetch).not.toHaveBeenCalled();
});
it('validates inputs/pricing/access before charging and scopes idempotency and downloads to the owner',()=>{
  for(const change of [{prompt:[]},{lyrics:42},{tags:[5]},{tags:Array(7).fill('tag')},{mode:'instrumental',lyrics:'words'},{n:2},{expected_cost:5}])expect(()=>createMusicTask({...input(),...change},owner)).toThrow();
  expect(balance()).toBe(100);
  const task=createMusicTask(input(),owner);
  expect(()=>ContentService.delete(row(task.id).content_id,1)).toThrow();
  expect(()=>createMusicTask({...input(),prompt:'different'},owner)).toThrow('不同内容');
  expect(()=>getMusicTask(task.id,{userId:2})).toThrow('不存在');expect(()=>musicFile(task.id,{tokenId:1,userId:1})).toThrow('不存在');
  expect(listMusicTasks({userId:2})).toEqual([]);
  expect(()=>createMusicTask({...input(),client_request_id:'denied_123'},{tokenId:1,userId:1,allowedModels:['other']})).toThrow('权限');
  expect(balance()).toBe(98);
});
it('refunds the original organization even when the user leaves it before completion',async()=>{
  db.insert(organizations).values({id:1,name:'Org',slug:'org',ownerId:1,balance:20}).run();sqlite.prepare('UPDATE users SET org_id=1 WHERE id=1').run();
  const task=createMusicTask(input(),owner);expect(db.select().from(organizations).get()?.balance).toBe(18);expect(balance()).toBe(100);
  sqlite.prepare('UPDATE users SET org_id=NULL WHERE id=1').run();vi.mocked(fetch).mockResolvedValue(Response.json({detail:'拒绝生成'},{status:400}));await processMusicTask(task.id);await resumeMusicTasks();
  expect(db.select().from(organizations).get()?.balance).toBe(20);expect(balance()).toBe(100);
  ContentService.delete(row(task.id).content_id,1);expect(listMusicTasks(owner)).toEqual([]);expect(()=>createMusicTask(input(),owner)).toThrow('已删除');
});
it('durable API token refund restores token quota rather than the user balance',async()=>{
  const token=TokenService.createToken({userId:1,balance:10});
  const apiOwner={userId:1,tokenId:token.id,reserve:(amount:number)=>reserveCharge(amount,cost=>{TokenService.deductBalance(token.id,cost);return {target:'api_token'};},amount=>TokenService.refundBalance(token.id,amount),{tokenId:token.id,userId:1,unlimitedToken:false})};
  const task=createMusicTask(input(),apiOwner);
  vi.mocked(fetch).mockResolvedValue(Response.json({detail:'无效模型'},{status:400}));await processMusicTask(task.id);await resumeMusicTasks();
  expect(db.select().from(apiTokens).get()).toMatchObject({balance:10,usedAmount:0});expect(balance()).toBe(100);
});
it('does not charge twice when upstream reuses the same task ID for distinct request keys',async()=>{
  vi.mocked(fetch).mockImplementation(async(_,init)=>Response.json({id:upstream,status:init?.method==='POST'?'queued':'running'}));
  const first=createMusicTask(input(),owner);await processMusicTask(first.id);
  const second=createMusicTask({...input(),client_request_id:'other_request'},owner);await processMusicTask(second.id);
  expect(getMusicTask(second.id,owner)).toMatchObject({status:'failed',cost:0,error:expect.stringContaining('重复订单')});expect(balance()).toBe(98);
});
it('a completed receipt survives a download interruption and recovery does not depend on another status query',async()=>{
  const task=createMusicTask(input(),owner);
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({id:upstream,status:'success',musicUrl:'https://cdn.example/a.mp3'})).mockRejectedValueOnce(new Error('download reset'));
  await processMusicTask(task.id);expect(row(task.id).receipt).toBeTruthy();expect(balance()).toBe(98);
  vi.mocked(fetch).mockClear();vi.mocked(fetch).mockResolvedValue(new Response(Buffer.from('ID3 music')));due();await resumeMusicTasks();
  expect(getMusicTask(task.id,owner).status).toBe('completed');expect(fetch).toHaveBeenCalledOnce();expect(String(vi.mocked(fetch).mock.calls[0][0])).toContain('/music/'+upstream+'/file');
});
it('manual settlement during query review prevents further processing and another refund',async()=>{
  const task=createMusicTask(input(),owner),c=sqlite.prepare('SELECT metadata FROM contents WHERE id=?').get(row(task.id).content_id) as any;
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({id:upstream,status:'queued'})).mockRejectedValueOnce(new Error('query reset'));await processMusicTask(task.id);
  resolveBillingReservation(JSON.parse(c.metadata).billingReservationId,1,0,'人工核实原任务失败，退费');
  vi.mocked(fetch).mockClear();due();
  await processMusicTask(task.id);expect(fetch).not.toHaveBeenCalled();expect(balance()).toBe(100);expect(getMusicTask(task.id,owner).status).toBe('resolved');
});
it('website route invokes the same durable queue and enforces model permissions',async()=>{
  const handler=(musicRouter as any).stack.find((r:any)=>r.route?.path==='/'&&r.route.methods.post).route.stack.at(-1).handle;
  const next=vi.fn(),denied=response();handler({userId:1,userRole:'user',availableModels:[],body:input()},denied,next);expect(denied.status).toHaveBeenCalledWith(403);expect(balance()).toBe(100);
  vi.mocked(fetch).mockResolvedValue(Response.json({detail:'积分不足'},{status:402}));
  const res=response();handler({userId:1,userRole:'user',availableModels:[{modelId:'my-song'}],body:input()},res,next);
  expect(next).not.toHaveBeenCalled();expect(res.status).toHaveBeenCalledWith(202);
  await vi.waitFor(()=>expect(getMusicTask(res.body.id,owner).status).toBe('failed'));expect(balance()).toBe(100);
});
function response(){const r:any={};r.status=vi.fn(()=>r);r.json=vi.fn(b=>{r.body=b;return r;});return r;}
function route(method:string,url:string){return (v1Router as any).stack.find((r:any)=>r.route?.path===url&&r.route.methods[method]).route.stack[0].handle;}
it('actual public API POST/GET enforce token ownership and retry the same accepted order without another charge',async()=>{
  const token=TokenService.createToken({userId:1,balance:10}),other=TokenService.createToken({userId:1,balance:10});
  vi.mocked(fetch).mockResolvedValue(Response.json({detail:'积分不足'},{status:402}));
  const req:any={body:input(),headers:{authorization:'Bearer '+token.tokenKey}},res=response(),next=vi.fn();
  route('post','/music')(req,res,next);expect(next).not.toHaveBeenCalled();expect(res.status).toHaveBeenCalledWith(202);
  await vi.waitFor(()=>expect(getMusicTask(res.body.id,{tokenId:token.id}).status).toBe('failed'));
  const again=response();route('post','/music')(req,again,next);expect(again.body.id).toBe(res.body.id);
  route('get','/music/:id')({headers:{authorization:'Bearer '+other.tokenKey},params:{id:res.body.id}},response(),next);
  expect(next).toHaveBeenLastCalledWith(expect.objectContaining({status:404}));expect(fetch).toHaveBeenCalledOnce();
});
