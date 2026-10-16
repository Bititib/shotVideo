import { ZONGHENG_VIDEO_MODELS, getZonghengVideoSpec } from '../shared/zonghengVideo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildZonghengVideoPayload, buildZonghengImagePayload, normalizeZonghengTask, zonghengRequestNotSent, zonghengTaskMetadata, submitZonghengVideo, ZonghengSubmissionError, zonghengBaseUrl, zonghengPollDelay, zonghengImageSize, validateZonghengVideoAliases } from '../server/services/zonghengAdapter';
import { prepareZonghengMedia, validateZonghengMedia } from '../server/services/zonghengMediaService';
import { generateZonghengImages } from '../server/services/zonghengImageService';
afterEach(() => vi.unstubAllGlobals());
const input = { model:'公开模型',prompt:' 产品展示 ',seconds:10,ratio:'9:16',resolution:'720p',images:['https://example.com/i.jpg'],videos:['https://example.com/v.mp4'],audios:['https://example.com/a.wav'],generateAudio:false };
const options = {baseUrl:'https://channel.invalid/v1/',apiKey:'test-key',publicBaseUrl:'https://our.invalid'};
describe('Zongheng public protocol', () => {
  it.each(ZONGHENG_VIDEO_MODELS)('validates confirmed parameters for $id and preserves the exact public ID', spec => {
    expect(getZonghengVideoSpec('ZH-' + spec.id)).toBe(spec);
    expect(getZonghengVideoSpec('zongheng-' + spec.id)).toBe(spec);
    for (const seconds of spec.seconds) {
      expect(buildZonghengVideoPayload({...input, model:spec.id, seconds, resolution:spec.resolution.toUpperCase(), videos:'references' in spec && spec.references.videos===0 ? [] : input.videos})).toMatchObject({model:spec.id, duration:seconds, resolution:spec.resolution});
    }
    for (const seconds of [spec.seconds[0] - 1, spec.seconds[spec.seconds.length - 1] + 1]) {
      expect(() => buildZonghengVideoPayload({...input,model:spec.id,seconds,resolution:spec.resolution})).toThrow('仅支持');
    }
    expect(() => buildZonghengVideoPayload({...input,model:spec.id,seconds:spec.seconds[0],resolution:spec.resolution === '480p' ? '1080p' : '480p'})).toThrow(spec.resolution);
  });
  it.each([{id:'kksedanco2.5',first:5,count:26},{id:'LLseadanco2.51',first:6,count:25},{id:'MMseadanco2.5-PRO',first:5,count:26},{id:'KKseadanco2.5X',first:5,count:26}])('keeps the user-confirmed 720p duration range for $id', ({id,first,count}) => {
    const spec = getZonghengVideoSpec('ZH-' + id)!;
    expect(spec).toMatchObject({id,resolution:'720p'});
    expect(spec.seconds[0]).toBe(first);
    expect(spec.seconds[spec.seconds.length - 1]).toBe(30);
    expect(spec.seconds).toHaveLength(count);
  });

  it.each([
    {id:'TTsedanco2.5-480',resolution:'480p'},
    {id:'TTseadanco2.5-720',resolution:'720p'},
  ])('keeps the exact TT model ID and its 5–30 second resolution profile for $id', ({id,resolution}) => {
    const spec = getZonghengVideoSpec('ZH-' + id)!;
    expect(spec).toMatchObject({id,family:'seedance',resolution});
    expect(spec.seconds).toEqual(Array.from({length:26},(_,i)=>i+5));
  });

  it.each(["Cseadanco2.5K","kksedanco2.5","LLseadanco2.51","TTsedanco2.5-480","TTseadanco2.5-720","MMseadanco2.5-PRO","KKseadanco2.5X"])('preserves 30 image, 10 video and 10 audio references for %s and rejects overflow', model => {
    const spec = getZonghengVideoSpec(model)!;
    const images = Array.from({length:30},(_,i)=>'https://media.invalid/i-'+i+'.jpg');
    const videos = Array.from({length:10},(_,i)=>'https://media.invalid/v-'+i+'.mp4');
    const audios = Array.from({length:10},(_,i)=>'https://media.invalid/a-'+i+'.mp3');
    const data = {...input,model,seconds:20,resolution:spec.resolution,images,videos,audios};
    expect(buildZonghengVideoPayload(data)).toMatchObject({images,reference_videos:videos,reference_audios:audios});
    for(const field of ['images','videos','audios'] as const){
      expect(()=>buildZonghengVideoPayload({...data,[field]:[...data[field],data[field][0]]})).toThrow('最多支持 30 张图片、10 个视频、10 段音频');
    }
  });

  it('keeps the 300-second label separate from the fixed 15-second output and enforces 9 images / 3 audios', () => {
    const model='sedanco2.0-300秒必出';
    expect(getZonghengVideoSpec('ZH-'+model)).toMatchObject({family:'seedance',resolution:'720p',seconds:[15],references:{images:9,videos:0,audios:3}});
    const data={...input,model,seconds:15,images:Array(9).fill('https://media.invalid/i.jpg'),videos:[],audios:Array(3).fill('https://media.invalid/a.mp3')};
    expect(buildZonghengVideoPayload(data)).toMatchObject({model,duration:15,images:data.images,reference_audios:data.audios});
    expect(buildZonghengVideoPayload(data)).not.toHaveProperty('reference_videos');
    for(const seconds of [5,10,14,16,30,300]) expect(()=>buildZonghengVideoPayload({...data,seconds})).toThrow('仅支持 15 秒');
    for(const field of ['images','videos','audios'] as const) {
      expect(()=>buildZonghengVideoPayload({...data,[field]:[...data[field],'https://media.invalid/extra']})).toThrow('最多支持 9 张图片、0 个视频、3 段音频');
    }
  });
  it('does not silently substitute similar-looking public model IDs', () => {
    expect(getZonghengVideoSpec('Cseadance2.5K')).toBeUndefined();
    expect(getZonghengVideoSpec('Xminimax-h3')).toBeUndefined();
    expect(getZonghengVideoSpec('kkseedance2.5')).toBeUndefined();
    expect(getZonghengVideoSpec('LLseadanco2.52')).toBeUndefined();
  });
  it('whitelists unified fields, preserves all materials and false audio setting', () => {
    const payload = buildZonghengVideoPayload({...input,extra:{secret:true},metadata:{upstream:'hidden'}} as any);
    expect(payload).toEqual({model:'公开模型',prompt:'产品展示',duration:10,ratio:'9:16',resolution:'720p',images:input.images,reference_videos:input.videos,reference_audios:input.audios,generate_audio:false});
    expect(buildZonghengVideoPayload({...input,images:[],firstFrame:'https://e/start',lastFrame:'https://e/end'})).toMatchObject({start_frame:'https://e/start',end_frame:'https://e/end'});
    expect(()=>buildZonghengVideoPayload({...input,lastFrame:'https://e/end'})).toThrow('首帧');
    expect(()=>buildZonghengVideoPayload({...input,firstFrame:'https://e/start'})).toThrow('混用');
    expect(()=>buildZonghengVideoPayload({...input,seconds:NaN})).toThrow();
  });
  it('rejects ambiguous reference aliases instead of discarding material', () => {
    expect(() => validateZonghengVideoAliases({images:['a'],image_urls:['b']})).toThrow('一个字段');
    expect(() => validateZonghengVideoAliases({reference_videos:'https://e/video'})).toThrow('数组');
    expect(() => validateZonghengVideoAliases({start_frame:'a',first_frame:'b'})).toThrow('一个字段');
    expect(() => validateZonghengVideoAliases({reference_audios:[null]})).toThrow('有效地址');
  });
  it('reads result URLs only after succeeded, rejects error envelopes and reports failure details', () => {
    expect(normalizeZonghengTask({status:'processing',video_url:'https://example.com/not-ready',next_poll_seconds:15})).toMatchObject({status:'processing',resultUrl:'',pollDelay:15000});
    expect(normalizeZonghengTask({status:'succeeded',video_url:'https://example.com/result'})).toMatchObject({status:'completed',resultUrl:'https://example.com/result',progress:100});
    expect(normalizeZonghengTask({status:'failed',error_code:'invalid_prompt',error_detail:'提示词审核'})).toMatchObject({status:'failed',error:'invalid_prompt: 提示词审核'});
    expect(()=>normalizeZonghengTask({error:{message:'busy'}})).toThrow();
    expect(zonghengPollDelay(-1)).toBe(10000); expect(zonghengPollDelay(300)).toBe(60000);
    expect(zonghengBaseUrl('https://provider.invalid/v1/')).toBe('https://provider.invalid');
  });
  it('persists submission before fetch, uses stable idempotency key, never retries unknown POSTs', async () => {
    const events:string[]=[];
    const fetcher=vi.fn(async (_url,init)=>{events.push('fetch');expect(init.headers['Idempotency-Key']).toBe('order-1');return Response.json({task_id:'vid_public',status:'processing',next_poll_seconds:14});});
    vi.stubGlobal('fetch',fetcher);
    expect(await submitZonghengVideo(options.baseUrl,options.apiKey,input,'order-1',()=>events.push('saved'))).toEqual({taskId:'vid_public',pollDelay:14000});
    expect(events).toEqual(['saved','fetch']);expect(fetcher.mock.calls[0][0]).toBe('https://channel.invalid/v1/videos');
    fetcher.mockRejectedValueOnce(new Error('timeout'));
    await expect(submitZonghengVideo(options.baseUrl,options.apiKey,input,'order-1',()=>{})).rejects.toMatchObject({uncertain:true});
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it.each([400,401,402,429,503,504])('classifies HTTP %s without unsafe retry', async status=>{
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:{message:'request rejected'}},{status})));
    await expect(submitZonghengVideo(options.baseUrl,options.apiKey,input,'order-1',()=>{})).rejects.toMatchObject({uncertain:status>=500});
  });
  it.each([
    {reason:'http_error',httpStatus:503,make:()=>Promise.resolve(Response.json({error:{message:'busy'}},{status:503}))},
    {reason:'invalid_task_response',httpStatus:200,make:()=>Promise.resolve(Response.json({success:true}))},
    {reason:'invalid_json',httpStatus:200,make:()=>Promise.resolve(new Response('<html>gateway</html>',{status:200}))},
    {reason:'timeout',httpStatus:undefined,make:()=>Promise.reject(new DOMException('secret provider timeout','TimeoutError'))},
    {reason:'network_error',httpStatus:undefined,make:()=>Promise.reject(new TypeError('secret provider URL sk-private-key',{cause:{code:'ENOTFOUND'}}))},
  ])('records safe $reason evidence while preserving uncertain submissions and never retrying POST',async ({reason,httpStatus,make})=>{
    vi.stubGlobal('fetch',vi.fn(make));
    const error=await submitZonghengVideo(options.baseUrl,options.apiKey,input,'order-diagnostic',()=>{}).catch(e=>e);
    expect(error).toBeInstanceOf(ZonghengSubmissionError);expect(error.uncertain).toBe(reason !== 'network_error');
    expect(error.diagnostics).toMatchObject({reason,httpStatus});expect(error.diagnostics.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(error.diagnostics)).not.toMatch(/secret|sk-private|https?:/);
    if(reason==='network_error')expect(error.diagnostics.networkCode).toBe('ENOTFOUND');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('recognizes generated-but-mirroring replies without inventing a result or completing the task', () => {
    const payload={status:'processing',progress:99,completed_at:'2026-10-16 13:35:20',delivery_pending:true,delivery_status:'mirroring',video_url:null,next_poll_seconds:10};
    expect(normalizeZonghengTask(payload)).toMatchObject({status:'processing',progress:99,resultUrl:'',upstreamGenerated:true,deliveryPending:true,progressText:'视频已生成，正在等待结果交付'});
    expect(zonghengTaskMetadata(payload)).toMatchObject({upstreamGenerated:true,upstreamDeliveryPending:true,upstreamDeliveryStatus:'mirroring'});
    expect(normalizeZonghengTask({...payload,status:'failed',error_detail:'交付失败'})).toMatchObject({status:'failed',deliveryPending:false,error:'交付失败'});
  });
  it('refund certainty uses connection evidence, not error text or a generic timeout', () => {
    expect(zonghengRequestNotSent(new TypeError('fetch failed',{cause:{code:'ENOTFOUND'}}))).toBe(true);
    expect(zonghengRequestNotSent(new AggregateError([{code:'ECONNREFUSED'},{code:'EAI_AGAIN'}]))).toBe(true);
    expect(zonghengRequestNotSent(new AggregateError([{code:'ECONNREFUSED'},{code:'ECONNRESET'}]))).toBe(false);
    expect(zonghengRequestNotSent(new DOMException('timeout','TimeoutError'))).toBe(false);
    expect(zonghengRequestNotSent({code:'ETIMEDOUT'})).toBe(false);
    expect(zonghengRequestNotSent({code:'ENOTFOUND'},200)).toBe(false);
    expect(zonghengRequestNotSent(new Error('ENOTFOUND'))).toBe(false);
  });
  it('uploads local bytes, keeps signed URLs, validates paths and 25MB limit before generation', async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'zongheng-media-'));
    try {
      await fs.writeFile(path.join(root,'reference.wav'),Buffer.from('RIFFtest'));
      const fetcher=vi.fn(async(_url,init)=>{expect(init.headers['Content-Type']).toBeUndefined();expect(init.body.getAll('file')).toHaveLength(1);return Response.json({success:true,data:[{url:'https://channel.invalid/api/media/uploads/audio.wav'}]});});
      vi.stubGlobal('fetch',fetcher);
      expect(await prepareZonghengMedia(['/uploads/reference.wav','https://media.invalid/a.wav?signature=a%2Bb'], 'audio',{...options,uploadsRoot:root})).toEqual(['https://channel.invalid/api/media/uploads/audio.wav','https://media.invalid/a.wav?signature=a%2Bb']);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await expect(validateZonghengMedia(['/uploads/%2e%2e/secret.wav'],'audio',{...options,uploadsRoot:root})).rejects.toThrow('不安全');
      await expect(validateZonghengMedia(['data:image/png;base64,'+Buffer.alloc(25*1024*1024+1).toString('base64')],'image',options)).rejects.toThrow('25MB');
      await expect(validateZonghengMedia(['https://127.0.0.1/file.jpg'],'image',options)).rejects.toThrow('公网');
    } finally {await fs.unlink(path.join(root,'reference.wav'));await fs.rmdir(root);}
  });
  it('uses image platform fields and rejects undocumented edits', async()=>{
    const i={model:'image-public',prompt:'画面',size:'2048x2048',aspectRatio:'1:1',quality:'standard',n:2};
    expect(zonghengImageSize('1:1','2K')).toBe('2048x2048');
    expect(buildZonghengImagePayload(i)).toEqual({model:'image-public',prompt:'画面',size:'2048x2048',aspect_ratio:'1:1',quality:'standard',n:2});
    expect(()=>buildZonghengImagePayload({...i,referenceImages:['data:image/png;base64,AA==']})).toThrow('编辑');
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({data:[{url:'/api/images/a.png'},{url:'https://media.invalid/b.png'}]})));
    expect(await generateZonghengImages(options.baseUrl,options.apiKey,i)).toEqual([{url:'https://channel.invalid/api/images/a.png'},{url:'https://media.invalid/b.png'}]);
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({success:true})));
    await expect(generateZonghengImages(options.baseUrl,options.apiKey,i)).rejects.toBeInstanceOf(ZonghengSubmissionError);
  });
});
