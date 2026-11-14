import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';
vi.mock('../server/db/index.js',async()=>(await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db, sqlite } from '../server/db/index.js';
import { apiTokens, organizations, users } from '../server/db/schema.js';
import { ensureFundLedger } from '../server/db/fundLedger.js';
import { ChannelService } from '../server/services/channelService.js';
import { getEnabledPublicModels } from '../server/services/modelCatalogService.js';
import { createMusicTask, ensureMusicJobs, getMusicTask, getMusicTaskByRequest, musicFile, processMusicTask, resumeMusicTasks } from '../server/services/musicGenerationService.js';
import { adminMusicDiagnostics, adminRecoverMusic, cancelMusicUpload, musicPrivateDir, removeMusicVoice } from '../server/services/sunoMusicJobs.js';
import { resolveBillingReservation } from '../server/services/billingReconciliation.js';
import channelRouter from '../server/routes/channels.js';
import musicRouter from '../server/routes/music.js';
import v1Router from '../server/routes/v1.js';
import { env } from '../server/config/env.js';

const owner={userId:1};
const model='suno-v6';
const base='https://www.suno-api.io';
const key='test-suno-credential';
const mp3=()=>new Response(Buffer.from('ID3 mock song'),{headers:{'Content-Type':'audio/mpeg'}});
const accepted=(tasks:any[]=[],status='queued')=>Response.json({success:true,data:{request_id:'ac_demo',status,tasks}},{status:202});
const song=(id:string,status='completed',extra={})=>({song_id:id,status,song_title:id,...extra});
const voices=(id='vp_owner',status='ready')=>Response.json({success:true,data:{voice_id:id,clip_id:status==='ready'?'voice_clip':undefined,status}});
const cover=(clips:any[],scene?:string)=>Response.json({code:200,data:{clips,resolved_scene:scene}});
const job=(id:string)=>sqlite.prepare('SELECT * FROM music_jobs WHERE id=?').get(id) as any;
const bill=(id:string)=>sqlite.prepare("SELECT r.* FROM billing_reservations r JOIN contents c ON r.id=json_extract(c.metadata,'$.billingReservationId') WHERE c.id=?").get(job(id).content_id) as any;
const ledger=(id:string)=>sqlite.prepare("SELECT kind,delta,account_type FROM fund_ledger f WHERE content_id=? OR EXISTS(SELECT 1 FROM fund_ledger_content_links l WHERE l.content_id=? AND l.entry_id=f.id) ORDER BY id").all(job(id).content_id,job(id).content_id);
const balance=(user=1)=>(sqlite.prepare('SELECT balance FROM users WHERE id=?').get(user) as any).balance;
const due=()=>sqlite.prepare('UPDATE music_jobs SET next_poll=0').run();
const input=(operation='generate',extra={})=>({model,operation,client_request_id:randomUUID(),...(operation==='generate'?{prompt:'海边民谣'}:{}),...extra});
const create=(data:ReturnType<typeof input>,file?:{path:string;name:string;mime:string;digest:string})=>createMusicTask(data,owner,file).task;
const files=new Set<string>();
let channelId:number;
let calls: ReturnType<typeof vi.fn>;
let localFetch:typeof fetch;
beforeAll(()=>{ensureMusicJobs();ensureFundLedger(sqlite);});
beforeEach(()=>{
  sqlite.exec('SAVEPOINT suno_test');
  localFetch=globalThis.fetch;
  calls=vi.fn(async()=>{throw new Error('Unexpected upstream request');});vi.stubGlobal('fetch',calls);
  db.insert(users).values([
    {id:1,email:'music@test.invalid',username:'music',passwordHash:'test',balance:100,role:'admin'},
    {id:2,email:'other@test.invalid',username:'other',passwordHash:'test',balance:100,role:'admin'},
  ]).run();
  sqlite.prepare("INSERT INTO tiers(id,name,display_name,allowed_features) VALUES(1,'free','Free','[\"music\"]')").run();
  sqlite.prepare('UPDATE users SET tier_id=1').run();
  channelId=ChannelService.createChannel({name:'Suno',type:'suno-api',baseUrl:base,apiKey:key,supportedModels:[model],modelMapping:{[model]:model}});
  sqlite.prepare("INSERT INTO models(model_id,display_name,provider,capabilities,is_active) VALUES(?,?,'suno-api','[\"music\"]',1)").run(model,model);
  sqlite.prepare("INSERT INTO model_pricing(model_pattern,billing_type,input_price,extra_params) VALUES(?,'per_call',2,?)")
    .run(model,JSON.stringify({enhanced_upload:7,voice_generation:3,enhanced_voice:8}));
});
afterEach(async()=>{
  for(const file of files)await fs.rm(file,{force:true});
  files.clear();
  const directory=path.join(musicPrivateDir(),'results');
  const names=await fs.readdir(directory).catch(()=>[] as string[]);
  for(const name of names)if(/^[0-9a-f-]{36}-(?:source|[0-9a-f-]{36})\.mp3$/.test(name)&&job(name.slice(0,36)))await fs.rm(path.join(directory,name),{force:true});
  vi.unstubAllGlobals();sqlite.exec('ROLLBACK TO suno_test; RELEASE suno_test');
});
function wav() {
  const samples=8000*7,buffer=Buffer.alloc(44+samples*2);
  buffer.write('RIFF');buffer.writeUInt32LE(buffer.length-8,4);buffer.write('WAVEfmt ',8);
  buffer.writeUInt32LE(16,16);buffer.writeUInt16LE(1,20);buffer.writeUInt16LE(1,22);
  buffer.writeUInt32LE(8000,24);buffer.writeUInt32LE(16000,28);buffer.writeUInt16LE(2,32);buffer.writeUInt16LE(16,34);
  buffer.write('data',36);buffer.writeUInt32LE(samples*2,40);return buffer;
}
async function localFile() {
  const file=path.join(musicPrivateDir(),'test-'+randomUUID()+'.wav');
  await fs.mkdir(musicPrivateDir(),{recursive:true});await fs.writeFile(file,wav());files.add(file);
  return {path:file,name:'sample.wav',mime:'audio/wav',digest:createHash('sha256').update(wav()).digest('hex')};
}
async function run(id:string){due();await processMusicTask(id);}
async function readyVoice() {
  const task=create(input('voice',{self_voice_confirmed:true}),await localFile());
  calls.mockResolvedValueOnce(voices());await run(task.id);return task.id;
}
async function withApp<T>(action:(url:string,web:string)=>Promise<T>){
  const app=express();
  app.use(express.json());app.use('/api/admin/channels',channelRouter);app.use('/api/music',musicRouter);app.use('/v1',v1Router);
  app.use((e:any,_req:any,res:any,_next:any)=>res.status(e.status||500).json({error:e.message}));
  const server=app.listen(0,'127.0.0.1');
  await new Promise<void>(resolve=>server.once('listening',resolve));
  try{const address=server.address();return await action('http://127.0.0.1:'+(address as any).port,jwt.sign({userId:1},env.JWT_SECRET));}
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
async function until(predicate:()=>boolean) {
  await vi.waitFor(()=>expect(predicate()).toBe(true));
}
it('uses the checked Suno catalog, imports disabled models and excludes legacy miniKey models without touching price',async()=>{
  sqlite.prepare("INSERT INTO models(model_id,display_name,provider,capabilities,is_active) VALUES('old-song','old-song','minikey','[\"music\"]',1)").run();
  sqlite.prepare("INSERT INTO models(model_id,display_name,provider,capabilities,is_active) VALUES('suno-v6-mini','suno-v6-mini','minikey','[\"music\"]',1)").run();
  sqlite.prepare("INSERT INTO model_pricing(model_pattern,billing_type,input_price) VALUES('suno-v6-mini','per_call',9)").run();
  calls.mockResolvedValueOnce(Response.json({data:[{id:model},{id:'suno-v6-mini'},{id:'suno-v5'},{id:'suno-v6-wild'}]}));
  expect(await ChannelService.syncModels(channelId)).toMatchObject({count:3,added:1});
  expect(getEnabledPublicModels('music',1).map(m=>m.modelId)).toEqual([model]);
  expect(sqlite.prepare("SELECT provider,is_active FROM models WHERE model_id='suno-v6-mini'").get()).toEqual({provider:'suno-api',is_active:0});
  expect(sqlite.prepare("SELECT input_price FROM model_pricing WHERE model_pattern='suno-v6-mini'").get()).toEqual({input_price:9});
  expect(()=>createMusicTask({...input(),model:'old-song'},owner)).toThrow('未启用');
  expect(calls).toHaveBeenCalledTimes(1);
});
it('runs the website queue, persists receipt before querying, transfers both MP3s and settles once',async()=>{
  const payload=input();
  calls.mockImplementation(async(url:string,init:RequestInit)=>{
    if(String(url).endsWith('/create')) {
      expect(job(taskId).state).toBe('submitting');expect(balance()).toBe(98);
      expect(JSON.parse(init.body as string)).toMatchObject({model,description:'海边民谣',accept_mode:'async'});
      return accepted();
    }
    if(String(url).endsWith('/requests/ac_demo')){expect(job(taskId).upstream_id).toBe('ac_demo');return accepted([song('first','pending'),song('second','pending')],'processing');}
    if(String(url).endsWith('/query'))return Response.json([song('first'),song('second')]);
    if(String(url).includes('/download?'))return mp3();
    throw new Error(url);
  });
  // Queue service is called by both entry points. Hold the first POST until its local ID is available.
  let taskId='';
  await withApp(async(url,web)=>{
    calls.mockImplementationOnce(async(_url:string,init:RequestInit)=>{
      await until(()=>Boolean(taskId));expect(job(taskId).state).toBe('submitting');
      expect(JSON.parse(init.body as string).accept_mode).toBe('async');return accepted();
    });
    const headers={Authorization:'Bearer '+web,'Content-Type':'application/json'};
    const response=await localFetch(url+'/api/music',{method:'POST',headers,body:JSON.stringify(payload)});
    expect(response.status).toBe(202);taskId=(await response.json()).id;
    const replay=await localFetch(url+'/api/music',{method:'POST',headers,body:JSON.stringify(payload)});
    expect((await replay.json()).id).toBe(taskId);
    await until(()=>job(taskId).lease===null);
    await run(taskId);
    calls.mockImplementationOnce(async()=>accepted([song('first'),song('second')],'completed'));
    await run(taskId);
    const task=getMusicTask(taskId,owner);
    expect(task.status,JSON.stringify(adminMusicDiagnostics(task.id))).toBe('completed');expect(task.results).toHaveLength(2);
    expect(await fs.readFile(musicFile(taskId,owner,task.results[1].id),'utf8')).toBe('ID3 mock song');
    const stranger=jwt.sign({userId:2},env.JWT_SECRET);
    expect((await localFetch(url+task.results[0].result_url,{headers:{Authorization:'Bearer '+stranger}})).status).toBe(404);
    await run(taskId);expect(balance()).toBe(98);
    expect(ledger(taskId)).toEqual([{kind:'charge',delta:-2,account_type:'user'}]);
    expect(getMusicTaskByRequest(payload.client_request_id,owner).id).toBe(taskId);
  });
});
it('refunds a documented rejection and an explicit task failure exactly once',async()=>{
  const reject=create(input());
  calls.mockResolvedValueOnce(Response.json({error:{code:'invalid_request_error',message:'描述不合要求'}},{status:400}));
  await run(reject.id);await resumeMusicTasks();
  expect(getMusicTask(reject.id,owner)).toMatchObject({status:'failed',refund_amount:2});
  expect(getMusicTask(reject.id,owner).error).toContain('描述不合要求');
  const fail=create(input());
  calls.mockResolvedValueOnce(accepted()).mockResolvedValueOnce(accepted([],'failed'));
  await run(fail.id);await run(fail.id);await run(fail.id);
  expect(balance()).toBe(100);expect(bill(fail.id).state).toBe('refunded');
  for(const id of [reject.id,fail.id]) expect(ledger(id).map((x:any)=>x.delta)).toEqual([-2,2]);
});
it('replays an interrupted text submission with the original wire bytes, key and account once',async()=>{
  const i=input(), task=create(i);let original:any;
  calls.mockImplementationOnce(async(_url:string,req:RequestInit)=>{original=req;throw new Error('connection reset after send');});
  await run(task.id);expect(getMusicTask(task.id,owner).status).toBe('review');expect(bill(task.id).state).toBe('reserved');
  expect(create(i).id).toBe(task.id);expect(()=>create({...i,prompt:'different'})).toThrow('不同内容');
  calls.mockImplementationOnce(async(_url:string,req:RequestInit)=>{
    expect(req.body).toBe(original.body);expect(req.headers).toEqual(original.headers);return accepted();
  });
  due();await Promise.all([resumeMusicTasks(),processMusicTask(task.id)]);
  expect(job(task.id).upstream_id).toBe('ac_demo');expect(job(task.id).replayed).toBe(1);
  expect(calls).toHaveBeenCalledTimes(2);expect(balance()).toBe(98);
});
it('keeps paid cover unknown on non-JSON gateway response, without retry, refund or fallback',async()=>{
  const asset=create(input('upload',{rights_confirmed:true}),await localFile());
  calls.mockResolvedValueOnce(Response.json({clip_id:'source_music',status:'complete',audio_url:'https://media.suno-api.io/source.mp3'}));
  await run(asset.id);expect(getMusicTask(asset.id,owner).asset_id).toBe(asset.id);
  expect(ledger(asset.id)).toEqual([]);expect(balance()).toBe(100);
  const task=create(input('cover',{asset_id:asset.id}));
  calls.mockImplementationOnce(async(url:string,init:RequestInit)=>{
    expect(url).toBe(base+'/api/music/generate-from-source');
    expect(JSON.parse(init.body as string)).toMatchObject({sourceClipId:'source_music'});
    return new Response('<html>gateway timeout</html>',{status:504});
  });
  await run(task.id);due();await resumeMusicTasks();
  expect(job(task.id).state).toBe('review');expect(bill(task.id).state).toBe('review');
  expect(balance()).toBe(98);expect(calls).toHaveBeenCalledTimes(2);
});
it('recovers voice cover via exact trace while preserving first result across query and download failures',async()=>{
  const voice=await readyVoice();
  const asset=create(input('upload',{rights_confirmed:true}),await localFile());
  calls.mockResolvedValueOnce(Response.json({clip_id:'song_source',status:'complete'}));await run(asset.id);
  const task=create(input('voice_cover',{asset_id:asset.id,voice_id:voice}));
  const trace=job(task.id).submission_key;
  calls.mockImplementationOnce(async(url:string,init:RequestInit)=>{
    expect(url).toContain('/voice-profile/cover');
    expect((init.headers as any)['X-Create-Ui-Client-Request-Id']).toBe(trace);
    expect(JSON.parse(init.body as string)).toMatchObject({voice_id:'vp_owner',song_clip_id:'song_source'});
    throw new Error('lost response');
  });
  await run(task.id);
  calls.mockResolvedValueOnce(Response.json({success:true,data:{items:['suno_a','suno_b','unrelated'].map(song_id=>({song_id,generation_type:'voice_profile_cover'}))}}));
  const detail=(id:string,index:number,request=trace)=>Response.json({success:true,data:{...song(id,'processing'),model,generation_type:'voice_profile_cover',
    client_request_id:request,client_request_index:index,parameters:{source_song_id:'song_source'}}});
  calls.mockResolvedValueOnce(detail('suno_a',0)).mockResolvedValueOnce(detail('suno_b',1)).mockResolvedValueOnce(detail('unrelated',0,'other'));
  calls.mockResolvedValueOnce(Response.json({success:false,message:'查询限流'},{status:429,headers:{'Retry-After':'60'}}));
  await run(task.id);expect(job(task.id).upstream_id).toBe('suno_a');expect(getMusicTask(task.id,owner).review_kind).toBe('query');
  expect(job(task.id).next_poll-Date.now()).toBeGreaterThan(50_000);
  calls.mockResolvedValueOnce(Response.json([song('suno_a'),song('suno_b')]))
    .mockResolvedValueOnce(mp3()).mockRejectedValueOnce(new Error('download reset'));
  await run(task.id);
  expect(getMusicTask(task.id,owner)).toMatchObject({review_kind:'storage',results:[{status:'completed'},{status:'saving'}]});
  calls.mockImplementationOnce(async url=>{expect(String(url)).toContain('song_id=suno_b');return mp3();});
  await run(task.id);expect(getMusicTask(task.id,owner).status,JSON.stringify(adminMusicDiagnostics(task.id))).toBe('completed');
  expect(calls.mock.calls.filter(([url,req])=>String(url).endsWith('/cover')&&req?.method==='POST')).toHaveLength(1);
  expect(balance()).toBe(97);
});
it('keeps partial results accessible and only refunds the amount established by reconciliation',async()=>{
  const voice=await readyVoice();
  const task=create(input('sing',{voice_id:voice}));
  calls.mockImplementationOnce(async(_url,init)=>{expect(JSON.parse(init.body)).not.toHaveProperty('song_clip_id');return cover([song('done'),song('bad','failed',{error_message:'审核未通过'})],'sing');});
  calls.mockResolvedValueOnce(mp3());await run(task.id);
  const result=getMusicTask(task.id,owner);
  expect(result.status).toBe('partial');expect(result.results[0].result_url).toBeTruthy();
  expect(result.results[1].error).toContain('审核未通过');expect(balance()).toBe(97);
  expect(bill(task.id).state).toBe('review');
  resolveBillingReservation(bill(task.id).id,1,2,'已核对单首费用及原回执');
  resolveBillingReservation(bill(task.id).id,1,2,'已核对单首费用及原回执');
  expect(balance()).toBe(98);expect(getMusicTask(task.id,owner).status).toBe('resolved');
  expect(ledger(task.id).map((x:any)=>x.delta)).toEqual([-3,1]);
});
it('charges and cancels an enhanced upload independently, using its task ID',async()=>{
  const task=create(input('enhanced_upload',{rights_confirmed:true,expected_cost:7}),await localFile());
  calls.mockImplementationOnce(async(url,init)=>{
    expect(url).toBe(base+'/api/music/enhanced-upload');expect((init.body as FormData).get('file')).toBeInstanceOf(Blob);
    return Response.json({success:true,data:{task_id:32,status:'queued',song_id:'pending:enhanced-upload:test'}});
  });
  await run(task.id);expect(balance()).toBe(93);
  calls.mockResolvedValueOnce(Response.json({success:true,data:{task_id:32,status:'cancelled'}}));
  expect((await cancelMusicUpload(task.id,owner)).status).toBe('cancelled');
  await cancelMusicUpload(task.id,owner);await run(task.id);
  expect(balance()).toBe(100);expect(calls.mock.calls[1][0]).toBe(base+'/api/music/enhanced-upload/32/cancel');
  expect(ledger(task.id).map((x:any)=>x.delta)).toEqual([-7,7]);
});
it('recovers an enhanced upload and enhanced voice independently then combines the two ready resources',async()=>{
  const asset=create(input('enhanced_upload',{rights_confirmed:true,expected_cost:7}),await localFile());
  const voice=create(input('enhanced_voice',{rights_confirmed:true,self_voice_confirmed:true,expected_cost:8}),await localFile());
  calls.mockResolvedValueOnce(Response.json({success:true,data:{task_id:41,status:'queued'}}));
  await run(asset.id);
  calls.mockImplementationOnce(async(_url,init)=>{expect((init.body as FormData).get('enhanced')).toBe('true');return voices('vp_extended','processing');});
  await run(voice.id);expect(balance()).toBe(85);
  calls.mockResolvedValueOnce(Response.json({success:true,data:{task:{task_id:41,status:'completed',song_id:'processed_song',
    audio_url:'https://media.code-go.com/assets/processed_song-mp3.mp3'}}})).mockResolvedValueOnce(mp3());
  await run(asset.id);
  calls.mockResolvedValueOnce(voices('vp_extended'));await run(voice.id);
  expect(getMusicTask(asset.id,owner).asset_id).toBe(asset.id);expect(getMusicTask(voice.id,owner).voice_id).toBe(voice.id);
  expect(bill(asset.id).state).toBe('settled');expect(bill(voice.id).state).toBe('settled');
  expect(()=>createMusicTask(input('voice_cover',{asset_id:asset.id,voice_id:voice.id}),{userId:2})).toThrow('不存在');
  const result=create(input('voice_cover',{asset_id:asset.id,voice_id:voice.id}));
  calls.mockImplementationOnce(async(_url,init)=>{
    expect(JSON.parse(init.body)).toMatchObject({song_clip_id:'processed_song',voice_id:'vp_extended'});
    return cover([song('first','failed',{error_message:'内容审核失败'}),song('second','failed')],'cover');
  });
  await run(result.id);
  expect(balance()).toBe(85);expect(bill(result.id).state).toBe('refunded');
  expect(bill(asset.id).state).toBe('settled');
  calls.mockResolvedValueOnce(Response.json({success:true,data:{voice_id:'vp_extended',status:'deleted'}}));
  expect((await removeMusicVoice(voice.id,owner)).status).toBe('deleted');
  await removeMusicVoice(voice.id,owner);
  expect(()=>create(input('sing',{voice_id:voice.id}))).toThrow('不存在');
});
it('authenticates external upload before receiving file and returns private reusable clips',async()=>{
  db.insert(apiTokens).values({id:11,tokenKey:'music-token',name:'music',userId:1,balance:30,allowedModels:'["suno-v6"]'}).run();
  await withApp(async url=>{
    const makeForm=()=>{const form=new FormData();form.append('options',JSON.stringify(input('upload',{rights_confirmed:true})));
      form.append('file',new Blob([wav()],{type:'audio/wav'}),'recording.wav');return form;};
    expect((await localFetch(url+'/v1/music/assets',{method:'POST',body:makeForm()})).status).toBe(401);
    const headers={Authorization:'Bearer music-token'};
    calls.mockResolvedValueOnce(Response.json({clip_id:'source_music',status:'complete'}));
    const response=await localFetch(url+'/v1/music/assets',{method:'POST',headers,body:makeForm()});
    expect(response.status).toBe(202);const task=await response.json();
    await until(()=>job(task.id).state==='completed');
    files.add(JSON.parse(job(task.id).payload).multipart.file);
    const binary=await localFetch(url+'/v1/music/assets/'+task.id+'/file',{headers});
    expect(binary.status).toBe(200);expect(binary.headers.get('content-type')).toMatch(/audio/);
    expect((await localFetch(url+'/api/music/assets/'+task.id+'/file',{headers:{Authorization:'Bearer '+jwt.sign({userId:1},env.JWT_SECRET)}})).status).toBe(404);
    const token=sqlite.prepare('SELECT balance FROM api_tokens WHERE id=11').get();
    expect(token).toEqual({balance:30});
  });
});
it('returns a rejected external order to the original token balance',async()=>{
  db.insert(apiTokens).values({id:11,tokenKey:'music-token',name:'music',userId:1,balance:30,allowedModels:'["suno-v6"]'}).run();
  calls.mockResolvedValueOnce(Response.json({success:false,error_code:'INSUFFICIENT_BALANCE',message:'余额不足'},{status:402}));
  await withApp(async url=>{
    const response=await localFetch(url+'/v1/music',{method:'POST',headers:{Authorization:'Bearer music-token','Content-Type':'application/json'},body:JSON.stringify(input())});
    expect(response.status).toBe(202);const task=await response.json();
    await until(()=>job(task.id).state==='failed');await run(task.id);
    expect(sqlite.prepare('SELECT balance FROM api_tokens WHERE id=11').get()).toEqual({balance:30});
    expect(ledger(task.id).map((row:any)=>[row.account_type,row.delta])).toEqual([['token_usage',2],['token',-2],['token_usage',-2],['token',2]]);
  });
});
it('returns rejected website purchase to the original organization after the user moves',async()=>{
  db.insert(organizations).values({id:1,name:'A',balance:40}).run();
  db.insert(organizations).values({id:2,name:'B',balance:40}).run();
  sqlite.prepare('UPDATE users SET org_id=1 WHERE id=1').run();
  const task=create(input());sqlite.prepare('UPDATE users SET org_id=2 WHERE id=1').run();
  calls.mockResolvedValueOnce(Response.json({success:false,message:'密钥禁用',error_code:'API_KEY_DISABLED'},{status:403}));
  await run(task.id);
  expect(sqlite.prepare('SELECT balance FROM organizations ORDER BY id').all()).toEqual([{balance:40},{balance:40}]);
  expect(ledger(task.id).map((row:any)=>[row.account_type,row.delta])).toEqual([['org',-2],['org',2]]);
});
it('records a 200 business rejection on voice creation instead of presenting an unknown task',async()=>{
  const task=create(input('voice',{self_voice_confirmed:true}),await localFile());
  calls.mockResolvedValueOnce(Response.json({success:false,message:'This audio matches an existing recording in our catalog.'}));
  await run(task.id);
  expect(getMusicTask(task.id,owner)).toMatchObject({status:'failed',error:expect.stringContaining('existing recording')});
  expect(ledger(task.id)).toEqual([]);
});
it('persists known song IDs on mismatched scenes without exposing the result or settling',async()=>{
  const voice=await readyVoice();
  const task=create(input('sing',{voice_id:voice}));
  calls.mockResolvedValueOnce(cover([song('foreign_a'),song('foreign_b')],'cover'));await run(task.id);
  expect(getMusicTask(task.id,owner)).toMatchObject({status:'review',review_kind:'conflict',result_url:null});
  expect(adminMusicDiagnostics(task.id).results.map(t=>t.upstreamId)).toEqual(['foreign_a','foreign_b']);
  expect(bill(task.id).state).toBe('review');
});
it('preserves a task ID in a contradictory response and only polls the same request',async()=>{
  const task=create(input());
  calls.mockResolvedValueOnce(Response.json({success:false,error:{code:'invalid_request_error',message:'上游回执异常'},
    data:{request_id:'ac_mixed',status:'queued',tasks:[]}},{status:400}));
  await run(task.id);
  expect(adminMusicDiagnostics(task.id)).toMatchObject({upstreamId:'ac_mixed',error:expect.stringContaining('invalid_request_error')});
  expect(getMusicTask(task.id,owner)).toMatchObject({status:'review',review_kind:'query'});
  expect(balance()).toBe(98);
  calls.mockImplementationOnce(async(url,req)=>{
    expect(url).toBe(base+'/api/music/requests/ac_mixed');expect(req.method).toBe('GET');
    return Response.json({success:true,data:{request_id:'ac_mixed',status:'failed',tasks:[],error_message:'原任务终止'}});
  });
  await run(task.id);await run(task.id);
  expect(getMusicTask(task.id,owner)).toMatchObject({status:'failed',refund_amount:2});
  expect(ledger(task.id).map((x:any)=>x.delta)).toEqual([-2,2]);
  expect(calls).toHaveBeenCalledTimes(2);
});

it('supplements an original single-result receipt without replacing the known result',async()=>{
  const voice=await readyVoice();
  const task=create(input('sing',{voice_id:voice}));
  calls.mockResolvedValueOnce(cover([song('original_first')],'sing')).mockResolvedValueOnce(mp3());
  await run(task.id);
  const first=getMusicTask(task.id,owner).results[0];
  expect(getMusicTask(task.id,owner).status).toBe('partial');
  await expect(adminRecoverMusic(task.id,1,{songIds:['unrelated'],evidence:'已查原单和上游回执'})).rejects.toThrow('必须保留');
  calls.mockImplementationOnce(async(url,req)=>{
    expect(url).toBe(base+'/api/music/query');
    expect(JSON.parse(req.body).song_ids).toBe('original_first,original_second');
    return Response.json([song('original_second'),song('original_first')]);
  });
  await adminRecoverMusic(task.id,1,{songIds:['original_second','original_first'],evidence:'已查原单第二首上游回执'});
  calls.mockResolvedValueOnce(mp3());
  await run(task.id);
  expect(getMusicTask(task.id,owner)).toMatchObject({status:'completed',results:[{id:first.id,status:'completed'},{status:'completed'}]});
  expect(adminMusicDiagnostics(task.id).upstreamId).toBe('original_first');
  expect(ledger(task.id).map((x:any)=>x.delta)).toEqual([-3]);
});

it('resumes an interrupted cancellation by querying the original task and refunds once',async()=>{
  const task=create(input('enhanced_upload',{rights_confirmed:true,expected_cost:7}),await localFile());
  calls.mockResolvedValueOnce(Response.json({success:true,data:{task_id:64,status:'queued'}}));
  await run(task.id);
  calls.mockRejectedValueOnce(new Error('connection reset after cancel'));
  await expect(cancelMusicUpload(task.id,owner)).rejects.toThrow();
  expect(balance()).toBe(93);
  calls.mockImplementationOnce(async(url,req)=>{
    expect(url).toBe(base+'/api/music/enhanced-upload/64');
    expect(req.method).toBe('GET');
    return Response.json({success:true,data:{task:{task_id:64,status:'cancelled'}}});
  });
  await run(task.id);await run(task.id);
  expect(getMusicTask(task.id,owner)).toMatchObject({status:'cancelled',refund_amount:7});
  expect(ledger(task.id).map((x:any)=>x.delta)).toEqual([-7,7]);
});

it('does not expose an upstream voice ID to a second account',async()=>{
  const original=await readyVoice();
  const task=createMusicTask(input('voice',{self_voice_confirmed:true}),{userId:2},await localFile()).task;
  calls.mockResolvedValueOnce(voices());
  await run(task.id);
  expect(getMusicTask(task.id,{userId:2})).toMatchObject({status:'review',review_kind:'conflict'});
  expect(getMusicTask(task.id,{userId:2}).voice_id).toBeUndefined();
  await expect(removeMusicVoice(task.id,{userId:2})).rejects.toMatchObject({status:404});
  expect(getMusicTask(original,owner)).toMatchObject({status:'completed',voice_id:original});
});

it('recovers a lost paid enhanced voice receipt through the exact client key and original details',async()=>{
  const task=create(input('enhanced_voice',{rights_confirmed:true,self_voice_confirmed:true,expected_cost:8,source_kind:'record'}),await localFile());
  const tracking=job(task.id).submission_key;
  calls.mockImplementationOnce(async(_url,req)=>{
    expect((req.body as FormData).get('client_request_id')).toBe(tracking);
    expect((req.body as FormData).get('source_kind')).toBe('record');
    throw new Error('lost enhanced voice response');
  });
  await run(task.id);
  calls.mockResolvedValueOnce(Response.json({success:true,data:{items:[]}}));
  await run(task.id);
  expect(job(task.id).state).toBe('submitting');
  expect(balance()).toBe(92);
  calls.mockImplementationOnce(async(url,req)=>{
    expect(url).toBe(base+'/api/music/voice-profile/list');expect(req.method).toBe('GET');
    return Response.json({success:true,data:{items:[
      {enhanced:true,client_request_id:'other',voice_id:'vp_other'},
      {enhanced:true,client_request_id:tracking,voice_id:'vp_recovered'},
    ]}});
  });
  calls.mockImplementationOnce(async url=>{
    expect(url).toBe(base+'/api/music/voice-profile/vp_recovered');
    return Response.json({success:true,data:{voice_id:'vp_recovered',task_id:23,status:'processing'}});
  });
  await run(task.id);
  expect(adminMusicDiagnostics(task.id)).toMatchObject({upstreamId:'vp_recovered',relatedTaskId:'23'});
  calls.mockResolvedValueOnce(voices('vp_recovered','failed'));
  await run(task.id);await run(task.id);
  expect(getMusicTask(task.id,owner)).toMatchObject({status:'failed',refund_amount:8});
  expect(ledger(task.id).map((x:any)=>x.delta)).toEqual([-8,8]);
  expect(calls.mock.calls.filter(([,req])=>req.method==='POST')).toHaveLength(1);
});

it('resumes the accepted task after a previous worker lease expires and blocks manual writes during recovery',async()=>{
  const task=create(input());
  calls.mockResolvedValueOnce(accepted());
  await run(task.id);
  sqlite.prepare("UPDATE music_jobs SET lease='interrupted-worker',lease_until=?,next_poll=0 WHERE id=?").run(Date.now()-10,task.id);
  sqlite.prepare("UPDATE billing_reservations SET state='review' WHERE id=?").run(bill(task.id).id);
  let release!: (response:Response)=>void;
  calls.mockImplementationOnce(async(url,req)=>{
    expect(url).toBe(base+'/api/music/requests/ac_demo');expect(req.method).toBe('GET');
    return new Promise<Response>(resolve=>{release=resolve;});
  });
  const resumed=resumeMusicTasks();
  await until(()=>Boolean(release));
  expect(job(task.id).lease).not.toBe('interrupted-worker');
  expect(()=>resolveBillingReservation(bill(task.id).id,1,0,'从后台核对该音乐原订单')).toThrow('正在查询');
  await expect(adminRecoverMusic(task.id,1,{evidence:'从后台核对该音乐原订单'})).rejects.toThrow('正在处理');
  release(accepted([],'failed'));
  await resumed;
  expect(getMusicTask(task.id,owner)).toMatchObject({status:'failed',refund_amount:2});
  expect(ledger(task.id).map((x:any)=>x.delta)).toEqual([-2,2]);
  expect(calls).toHaveBeenCalledTimes(2);
});

it('configures Suno from an authenticated admin request using only upstream GETs and preserves existing prices',async()=>{
  sqlite.prepare("UPDATE channels SET api_key='',status=0,supported_models='[]',model_mapping='{}' WHERE id=?").run(channelId);
  sqlite.prepare("UPDATE models SET is_active=0 WHERE model_id=?").run(model);
  calls.mockImplementation(async(url:string,init:RequestInit)=>{
    expect(init.method).toBe('GET');
    expect(init.headers).toMatchObject({Authorization:'Bearer '+key});
    if(url===base+'/api/user/balance')return Response.json({success:true,data:{balance:{effective_amount:19.8}}});
    if(url===base+'/v1/models')return Response.json({data:[{id:model},{id:'suno-v6-mini'},{id:'unrelated'}]});
    throw new Error('Unexpected request '+url);
  });
  await withApp(async(url,web)=>{
    const endpoint=url+'/api/admin/channels/'+channelId+'/suno-setup';
    const body=JSON.stringify({apiKey:key});
    const anonymous=await localFetch(endpoint,{method:'PUT',headers:{'Content-Type':'application/json'},body});
    expect(anonymous.status).toBe(401);
    const response=await localFetch(endpoint,{method:'PUT',headers:{Authorization:'Bearer '+web,'Content-Type':'application/json'},body});
    expect(response.status).toBe(200);
    const result=await response.json();
    expect(result).toMatchObject({balance:19.8,models:[model,'suno-v6-mini'],modelStatus:[
      {model,priced:true,enabled:true},{model:'suno-v6-mini',priced:false,enabled:false},
    ]});
    expect(JSON.stringify(result)).not.toContain(key);
  });
  expect(calls.mock.calls.map(([url])=>url).sort()).toEqual([base+'/api/user/balance',base+'/v1/models']);
  expect(getEnabledPublicModels('music',1).map(m=>m.modelId)).toEqual([model]);
  expect(sqlite.prepare("SELECT input_price FROM model_pricing WHERE model_pattern=?").get(model)).toEqual({input_price:2});
  expect(sqlite.prepare("SELECT status,last_test_result FROM channels WHERE id=?").get(channelId)).toMatchObject({
    status:1,last_test_result:expect.stringContaining('19.8'),
  });
});

it('keeps the existing Suno key and model bindings on a rejected replacement key',async()=>{
  const before=sqlite.prepare('SELECT api_key,status,supported_models,model_mapping FROM channels WHERE id=?').get(channelId);
  calls.mockImplementation(async(url:string)=>url.endsWith('/balance')
    ? Response.json({success:true,data:{balance:{effective_amount:0}}})
    : Response.json({error:{message:'Invalid token rejected-key',code:'INVALID_API_KEY'}},{status:401}));
  await withApp(async(url,web)=>{
    const response=await localFetch(url+'/api/admin/channels/'+channelId+'/suno-setup',{
      method:'PUT',headers:{Authorization:'Bearer '+web,'Content-Type':'application/json'},body:JSON.stringify({apiKey:'rejected-key'}),
    });
    expect(response.ok).toBe(false);
    const data=await response.json();
    expect(data.error).toContain('INVALID_API_KEY');
    expect(data.error).not.toContain('rejected-key');
  });
  expect(sqlite.prepare('SELECT api_key,status,supported_models,model_mapping FROM channels WHERE id=?').get(channelId)).toEqual(before);
  expect(calls.mock.calls.every(([,init])=>init.method==='GET')).toBe(true);
});
