import { expect, it } from 'vitest';
import { SNUMOM_MUSE_CONFIRMED, SNUMOM_MUSE_CATALOG } from '../shared/snumomMuse';
import { buildSnumomWanPayload, normalizeSnumomMuseRequestBody, SNUMOM_VIDEO_MODELS } from '../server/services/snumomWanAdapter';
import { existingModelLimits } from '../server/services/modelInputPresets';

it('records only confirmed Muse catalog facts, not WAN capabilities or USD customer prices',()=>{
  expect(SNUMOM_MUSE_CONFIRMED).toEqual({resolution:'720p',seconds:10,maxImages:8,billingType:'per_call',endpointType:'openai-video'});
  expect(SNUMOM_MUSE_CATALOG.isActive).toBe(0);
  expect(SNUMOM_MUSE_CATALOG).not.toHaveProperty('inputPrice');
  expect(SNUMOM_MUSE_CONFIRMED).not.toHaveProperty('ratios');
  expect(SNUMOM_VIDEO_MODELS).toContain('muse-video');
  expect(existingModelLimits('muse-video','video')).toMatchObject({maxImages:8,maxVideos:0,maxAudios:0,resolutions:['720p'],duration:{mode:'fixed',min:10,max:10},firstFrame:false,lastFrame:false});
});
it('normalizes aliases and serializes snumom JSON without losing eight images',()=>{
  const images=Array.from({length:8},(_,i)=>({url:`https://assets.invalid/${i}.jpg`}));
  const body=normalizeSnumomMuseRequestBody({model:'muse-video',prompt:'test',images,seconds:'10',size:'720P'});
  expect(body).toMatchObject({seconds:10,video_length:10,resolution:'720p',reference_images:images.map(i=>i.url)});
  expect(buildSnumomWanPayload({...body,aspectRatio:body.aspect_ratio,images})).toMatchObject({model:'muse-video',seconds:'10',size:'720P',reference_images:images});
});
it.each([{seconds:15},{size:'1080p'},{reference_images:Array(9).fill('https://a.invalid/1.jpg')},{reference_videos:['https://a.invalid/a.mp4']},{audio_url:'https://a.invalid/a.mp3'},{first_frame:'https://a.invalid/1.jpg'},{reference_images:[{url:'https://a.invalid/1.jpg',role:'last_frame'}]},{images:['https://a.invalid/1.jpg'],reference_images:['https://a.invalid/2.jpg']},{parameters:{duration:-1}},{ratio:'bogus'}])('rejects unsupported Muse input %j',patch=>{
  expect(()=>normalizeSnumomMuseRequestBody({model:'muse-video',...patch})).toThrow();
});
