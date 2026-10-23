import { ZONGHENG_VIDEO_MODELS, getZonghengVideoSpec } from '../shared/zonghengVideo';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildZonghengVideoPayload, buildZonghengImagePayload, normalizeZonghengTask, zonghengRequestNotSent, zonghengTaskMetadata, submitZonghengVideo, ZonghengSubmissionError, zonghengBaseUrl, zonghengImageSize, validateZonghengVideoAliases } from '../server/services/zonghengAdapter';
import { prepareZonghengMedia, validateZonghengMedia } from '../server/services/zonghengMediaService';
import { generateZonghengImages } from '../server/services/zonghengImageService';
afterEach(() => vi.unstubAllGlobals());
const input = { model:'公开模型',prompt:' 产品展示 ',seconds:10,ratio:'9:16',resolution:'720p',images:['https://example.com/i.jpg'],videos:['https://example.com/v.mp4'],audios:['https://example.com/a.wav'] };
const options = {baseUrl:'https://channel.invalid/v1/',apiKey:'test-key',publicBaseUrl:'https://our.invalid'};
describe('Zongheng public protocol', () => {
  it.each(ZONGHENG_VIDEO_MODELS)('validates confirmed parameters for $id and preserves the exact public ID', spec => {
    expect(getZonghengVideoSpec('ZH-' + spec.id)).toBe(spec);
    expect(getZonghengVideoSpec('zongheng-' + spec.id)).toBe(spec);
    for (const seconds of spec.seconds) {
      expect(buildZonghengVideoPayload({...input, model:spec.id, seconds, resolution:spec.resolution.toUpperCase(), videos:'references' in spec && spec.references.videos===0 ? [] : input.videos})).toMatchObject({model:spec.id, seconds:seconds, resolution:spec.resolution});
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
    expect(buildZonghengVideoPayload(data)).toMatchObject({images,videos:videos,audios:audios});
    for(const field of ['images','videos','audios'] as const){
      expect(()=>buildZonghengVideoPayload({...data,[field]:[...data[field],data[field][0]]})).toThrow('最多支持 30 张图片、10 个视频、10 段音频');
    }
  });

  it('keeps the 300-second label separate from the fixed 15-second output and enforces 9 images / 3 audios', () => {
    const model='sedanco2.0-300秒必出';
    expect(getZonghengVideoSpec('ZH-'+model)).toMatchObject({family:'seedance',resolution:'720p',seconds:[15],references:{images:9,videos:0,audios:3}});
    const data={...input,model,seconds:15,images:Array(9).fill('https://media.invalid/i.jpg'),videos:[],audios:Array(3).fill('https://media.invalid/a.mp3')};
    expect(buildZonghengVideoPayload(data)).toMatchObject({model,seconds:15,images:data.images,audios:data.audios});
    expect(buildZonghengVideoPayload(data)).not.toHaveProperty('videos');
    for(const seconds of [5,10,14,16,30,300]) expect(()=>buildZonghengVideoPayload({...data,seconds})).toThrow('仅支持 15 秒');
    for(const field of ['images','videos','audios'] as const) {
      expect(()=>buildZonghengVideoPayload({...data,[field]:[...data[field],'https://media.invalid/extra']})).toThrow('最多支持 9 张图片、0 个视频、3 段音频');
    }
  });
  it('preserves the QQ slash ID with fixed 30 seconds and all 30/10/10 references', () => {
    const model='QQsedanco2.5/720';
    expect(getZonghengVideoSpec('ZH-'+model)).toMatchObject({id:model,family:'seedance',resolution:'720p',seconds:[30],references:{images:30,videos:10,audios:10}});
    const data={...input,model,seconds:30,images:Array(30).fill('https://media.invalid/i.jpg'),videos:Array(10).fill('https://media.invalid/v.mp4'),audios:Array(10).fill('https://media.invalid/a.mp3')};
    expect(buildZonghengVideoPayload(data)).toMatchObject({model,seconds:30,resolution:'720p',images:data.images,videos:data.videos,audios:data.audios});
    for(const seconds of [5,10,15,29,31]) expect(()=>buildZonghengVideoPayload({...data,seconds})).toThrow('仅支持 30 秒');
    for(const field of ['images','videos','audios'] as const) expect(()=>buildZonghengVideoPayload({...data,[field]:[...data[field],data[field][0]]})).toThrow('最多支持 30 张图片、10 个视频、10 段音频');
  });
  it('does not silently substitute similar-looking public model IDs', () => {
    expect(getZonghengVideoSpec('Cseadance2.5K')).toBeUndefined();
    expect(getZonghengVideoSpec('Xminimax-h3')).toBeUndefined();
    expect(getZonghengVideoSpec('kkseedance2.5')).toBeUndefined();
    expect(getZonghengVideoSpec('LLseadanco2.52')).toBeUndefined();
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
