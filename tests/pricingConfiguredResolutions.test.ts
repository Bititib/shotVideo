import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db, sqlite } from '../server/db/index.js';
import { models, modelPricing, settings } from '../server/db/schema.js';
import { PricingService } from '../server/services/pricingService.js';
import { quoteVideoRequest } from '../server/services/videoQuoteService.js';

const model = 'SD-seedance2.5';
beforeEach(() => {
  sqlite.exec('DELETE FROM models; DELETE FROM model_pricing; DELETE FROM settings;');
  db.insert(models).values({modelId:model,displayName:model,capabilities:'["video"]',isActive:1}).run();
  db.insert(settings).values({key:'model_specification_routes_v1',value:JSON.stringify([{modelId:model,kind:'video',enabled:true,
    limits:{resolutions:['480p','720p','1080p'],duration:{mode:'range',min:5,max:30,step:1,values:[]}},routes:[]}])}).run();
});

it('returns specification resolutions before pricing exists without creating prices or changing activation', () => {
  sqlite.prepare('UPDATE models SET is_active=0').run();
  const spec = JSON.parse((sqlite.prepare('SELECT value FROM settings').get() as any).value);
  spec[0].enabled = false;
  sqlite.prepare('UPDATE settings SET value=?').run(JSON.stringify(spec));
  const [rule] = PricingService.getPricingRules({scope:'models',modelId:model});
  expect(rule).toMatchObject({configured:false,modelActive:false,resolutionOptions:['480p','720p','1080p'],extraParams:{category:'video'}});
  expect(sqlite.prepare('SELECT COUNT(*) AS n FROM model_pricing').get()).toEqual({n:0});
});

it('keeps existing prices manageable when optional specification metadata is missing or invalid', () => {
  PricingService.createPricingRule({modelPattern:model,billingType:'per_second',inputPrice:.4,extraParams:{'720p':.5}});
  sqlite.prepare('UPDATE settings SET value=?').run('invalid-json');
  const [rule] = PricingService.getPricingRules({modelId:model});
  expect(rule.resolutionOptions).toBeUndefined();
  expect(rule.extraParams['720p']).toBe(.5);
  expect(rule.inputPrice).toBe(.4);
});

it.each([
  ['per_second',.4,{'480p':.28,'1080p':.9},[2.8,4,9]],
  ['per_call',5.3,{'480p':4.5,'1080p':8.5},[4.5,5.3,8.5]],
] as const)('uses saved %s resolution rates in browser quotes, API pricing and snapshots', (billingType,base,extras,expected) => {
  PricingService.createPricingRule({modelPattern:model,billingType,inputPrice:base,extraParams:{category:'video'}});
  const [rule] = PricingService.getPricingRules({modelId:model});
  expect(rule.resolutionOptions).toEqual(['480p','720p','1080p']);
  PricingService.updatePricingRule(rule.id,{extraParams:{category:'video',...extras}});
  const apiQuote = PricingService.createQuoteResolver(false,null);
  for (const [i,resolution] of ['480p','720p','1080p'].entries()) {
    expect(quoteVideoRequest({model,seconds:10,resolution}).cost).toBe(expected[i]);
    expect(apiQuote(model,{seconds:10,resolution,count:1}).cost).toBe(expected[i]);
  }
  expect(PricingService.getPublicPricingForModels([model])[0]).toMatchObject({billing_type:billingType,unit_price:base,resolution_prices:extras});
  const before = apiQuote(model,{seconds:10,resolution:'1080p',count:1});
  PricingService.updatePricingRule(rule.id,{extraParams:{category:'video','1080p':99}});
  expect(PricingService.quoteSnapshot(before.pricingSnapshot!).cost).toBe(expected[2]);
});
