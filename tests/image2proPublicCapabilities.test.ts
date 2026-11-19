import { expect, it, vi } from 'vitest';
import { enrichImage2proCatalog } from '../server/services/image2proPublicCapabilities.js';
import { defaultRoutingLimits } from '../shared/modelRouting.js';
import type { ChannelModelCatalogEntry } from '../shared/channelModelConfiguration.js';
const entry=():ChannelModelCatalogEntry=>({id:'model-a',kind:'image',limits:{...defaultRoutingLimits(),ratios:['auto'],resolutions:['auto'],maxImages:0},imageOptions:{customRatios:true,customResolutions:true,maxImages:16}});
const html='const RATIO_OPTIONS_BY_PROTOCOL = {\n"openai": [{ value: "1:1" },{ value: "16:9" },{ value: "1.58:1" }]\n};\nconst MAX_REF_IMAGES=6;';
function source(overrides:any={}) {return vi.fn(async(url:any)=>Response.json({ok:true,models:String(url).includes('public-models')?[{id:'model-a',name:'Model A',type:'image',supportsReference:true,...overrides}]:[{id:'internal-id',name:'Model A',type:'image',protocol:'openai',openaiResolution:'4K'}]})).mockImplementation(async(url:any)=>String(url)==='https://image2pro.top/'?new Response(html):Response.json({ok:true,models:String(url).includes('public-models')?[{id:'model-a',name:'Model A',type:'image',supportsReference:true,...overrides}]:[{id:'internal-id',name:'Model A',type:'image',protocol:'openai',openaiResolution:'4K'}]}));}
it('fills authorized models only and labels defaults, website limits and unsupported decimals',async()=>{
 const fetcher=source();const original=entry();const [result]=await enrichImage2proCatalog([original],fetcher);
 expect(result.limits).toMatchObject({ratios:['1:1','16:9'],resolutions:['4K'],maxImages:6});
 expect(original.limits?.resolutions).toEqual(['auto']);expect(result.id).toBe('model-a');
 expect(result.imageEvidence?.notes.join(' ')).toContain('默认值不等于上限');expect(result.imageEvidence?.notes.join(' ')).toContain('API 上限未公布');expect(result.imageEvidence?.notes.join(' ')).toContain('1.58:1');
 for(const call of fetcher.mock.calls)expect(call[1]).not.toHaveProperty('headers');
});
it('keeps authoritative limits including 16 and never overrides enumerations',async()=>{
 const e=entry();e.imageOptions={customRatios:false,customResolutions:false,maxImages:16,referenceLimitPublished:true};e.limits={...e.limits!,maxImages:16,resolutions:['2K'],ratios:['3:2']};
 const [result]=await enrichImage2proCatalog([e],source());expect(result.limits).toEqual(e.limits);
});
it('sets unsupported references to zero instead of using the website picker ceiling',async()=>{
 const [result]=await enrichImage2proCatalog([entry()],source({supportsReference:false}));expect(result.limits?.maxImages).toBe(0);
});
it('fails open to authorized values without exposing upstream errors or inventing capabilities',async()=>{
 const e=entry();const fetcher=vi.fn(async()=>{throw Error('private details');});const [result]=await enrichImage2proCatalog([e],fetcher);
 expect(result.limits).toEqual(e.limits);expect(result.imageEvidence?.notes.join(' ')).toContain('未公布');expect(result.imageEvidence?.notes.join(' ')).not.toContain('private details');
});
it('does not infer capabilities from model name without an exact public mapping',async()=>{
 const e={...entry(),id:'unknown-4K'};const [result]=await enrichImage2proCatalog([e],source());expect(result.limits).toEqual(e.limits);
});
