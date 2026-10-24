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
      expect(buildZonghengVideoPayload({...input, model:spec.id, seconds, resolution:spec.resolution.toUpperCase(), videos:spec.references.videos ? input.videos : [],audios:spec.references.audios ? input.audios : []})).toMatchObject({model:spec.id, seconds:seconds, resolution:spec.resolution});
    }
    for (const seconds of [spec.seconds[0] - 1, spec.seconds[spec.seconds.length - 1] + 1]) {
      expect(() => buildZonghengVideoPayload({...input,model:spec.id,seconds,resolution:spec.resolution})).toThrow('仅支持');
    }
    expect(() => buildZonghengVideoPayload({...input,model:spec.id,seconds:spec.seconds[0],resolution:spec.resolution === '480p' ? '1080p' : '480p'})).toThrow(spec.resolution);
  });
  it.each(['QQsedanco2.5/720', 'kksedanco2.5', 'LLseadanco2.51', 'TTsedanco2.5-480', 'KKseadanco2.5X', 'MMseadanco2.5-PRO'])('removes retired-site specifications for %s', id => {
    expect(getZonghengVideoSpec(id)).toBeUndefined();
  });
  it.each(ZONGHENG_VIDEO_MODELS)('enforces the new-site reference counts for $id', spec => {
    const data = {...input,model:spec.id,seconds:spec.seconds[0],resolution:spec.resolution,
      images:Array(spec.references.images).fill('https://media.invalid/i.jpg'),
      videos:Array(spec.references.videos).fill('https://media.invalid/v.mp4'),
      audios:Array(spec.references.audios).fill('https://media.invalid/a.mp3')};
    expect(buildZonghengVideoPayload(data).model).toBe(spec.id);
    for(const field of ['images','videos','audios'] as const) {
      expect(()=>buildZonghengVideoPayload({...data,[field]:[...data[field],'https://media.invalid/extra']})).toThrow('最多支持');
    }
  });
  it('keeps exact new-site IDs, including spaces and slashes, without substituting old spellings', () => {
    expect(getZonghengVideoSpec('TTseadanco2.5-480')).toMatchObject({resolution:'480p'});
    expect(getZonghengVideoSpec('TTseadanco 2.0 Fast/720')).toMatchObject({resolution:'720p'});
    expect(getZonghengVideoSpec('dola2.0')?.seconds).toEqual([15]);
    expect(getZonghengVideoSpec('dola2.5')?.seconds).toEqual([5,10,15]);
    expect(getZonghengVideoSpec('TTsedanco2.5-480')).toBeUndefined();
    expect(getZonghengVideoSpec('TTseadanco2.0 Fast/720')).toBeUndefined();
  });
  it('rejects unsupported Grok ratios before submission', () => {
    const data={...input,model:'grok-imagine-1.5',videos:[],audios:[],ratio:'4:3'};
    expect(()=>buildZonghengVideoPayload(data)).toThrow('仅支持比例');
    expect(buildZonghengVideoPayload({...data,ratio:'1:1'}).ratio).toBe('1:1');
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
