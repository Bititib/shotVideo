import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
// This test repeatedly runs startup migrations and must never open the local app.db.
vi.mock('../server/db/index.js', async () => {
  const { default: Database } = await import('better-sqlite3');
  const { drizzle } = await import('drizzle-orm/better-sqlite3');
  const sqlite = new Database(':memory:');
  return { sqlite, db: drizzle(sqlite) };
});
vi.mock('../server/config/env.js', () => ({
  env: {
    NODE_ENV: 'test', GEMINI_API_KEY: '', GEMINI_API_BASE_URL: 'https://google.invalid',
    HM_STUDIO_API_KEY: '', WX_HAIDIYUE_API_KEY: '', MINGFEI_API_KEY: '',
    NEWTOKEN_BASE_URL: 'https://newtoken.club', NEWTOKEN_API_KEY: '',
    SNUMOM_BASE_URL: 'https://snumom.com', SNUMOM_API_KEY: '',
    ADMIN_EMAIL: 'url-persistence@test.invalid', ADMIN_PASSWORD: 'test-only-password',
  }, getApiKeys: () => [],
}));
import { db } from '../server/db/index';
import { PricingService } from '../server/services/pricingService';
import { channels, models, modelPricing } from '../server/db/schema';
import { initDatabase } from '../server/db/seed';
import { ChannelService } from '../server/services/channelService';
import { AdminService } from '../server/services/adminService';

const fixtures = [
  { name: 'HM Studio 渠道', type: 'hmstudio' },
  { name: 'snumom 视频渠道', type: 'snumom' },
  { name: 'wx-海底月渠道', type: 'wx-haidiyue' },
  { name: 'LongXia 视频渠道', type: 'longxia' },
  { name: 'MingFei 图片渠道', type: 'mingfei' },
  { name: 'NewToken 渠道', type: 'openai' },
  { name: '4月天 渠道', type: 'openai' },
  { name: 'Pidoi 图片渠道', type: 'openai' },
  { name: 'MJNewAPI 渠道', type: 'openai' },
  { name: 'AI开放平台 (julun.cc) 渠道', type: 'openai' },
  { name: '纵横自定义渠道', type: 'zongheng' },
];
const defaults = [
  { type: 'hmstudio', url: 'https://dnyovzpgyokm.sealosbja.site' },
  { type: 'snumom', url: 'https://snumom.com' },
  { type: 'wx-haidiyue', url: 'https://ap.968968968.xyz/v1' },
];
const originalDefaults = new Map<string, string>();
const network = vi.fn(async () => { throw Error('External calls disabled in test'); });
const byName = (name: string) => db.select().from(channels).all().find(row => row.name === name)!;

beforeAll(async () => {
  vi.stubGlobal('fetch', network);
  for (const key of ['SI_YUE_TIAN_API_KEY', 'PIDOI_IMAGE_API_KEY', 'MJNEWAPI_API_KEY', 'JULUN_API_KEY']) vi.stubEnv(key, '');
  await initDatabase();
  for (const { type } of defaults) originalDefaults.set(type, db.select().from(channels).all().find(row => row.type === type)!.baseUrl);
  ChannelService.createChannel({ name: '纵横自定义渠道', type: 'zongheng',
    baseUrl: 'https://zongheng.invalid', apiKey: 'test-only-key' });
});
afterAll(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('administrator channel URLs survive startup', () => {
  it('still initializes default addresses on a fresh database', () => {
    for (const { type, url } of defaults) expect(originalDefaults.get(type)).toBe(url);
  });
  it.each(fixtures)('keeps the saved $name URL and original channel identity across two startups', async ({ name }) => {
    const channel = byName(name);
    const replacement = 'https://replacement-' + channel.id + '.invalid/custom/v1';
    ChannelService.updateChannel(channel.id, { baseUrl: replacement });
    const savedUrl = db.select().from(channels).where(eq(channels.id, channel.id)).get()!.baseUrl;
    expect(new URL(savedUrl).origin).toBe(new URL(replacement).origin);
    const count = db.select().from(channels).all().length;
    for (let restart = 0; restart < 2; restart++) {
      await initDatabase();
      expect(db.select().from(channels).where(eq(channels.id, channel.id)).get()?.baseUrl).toBe(savedUrl);
      expect(db.select().from(channels).all()).toHaveLength(count);
      expect(db.select().from(channels).all().filter(row => row.name === name)).toHaveLength(1);
    }
  });
  it.each(defaults)('fills an empty $type address without affecting other configured addresses', async ({ type, url }) => {
    const channel = db.select().from(channels).all().find(row => row.type === type)!;
    const zongheng = byName('纵横自定义渠道');
    db.update(channels).set({ baseUrl: '' }).where(eq(channels.id, channel.id)).run();
    await initDatabase();
    expect(db.select().from(channels).where(eq(channels.id, channel.id)).get()?.baseUrl).toBe(url);
    expect(byName('纵横自定义渠道').baseUrl).toBe(zongheng.baseUrl);
  });
  it('preserves the HM endpoint when an administrator creates and edits a model', () => {
    const channel = byName('HM Studio 渠道');
    const baseUrl = 'https://hm-replacement.invalid/proxy/v1';
    ChannelService.updateChannel(channel.id, { baseUrl });
    AdminService.createModel({ provider: 'hmstudio', modelId: 'hm-url-regression',
      displayName: 'HM URL regression', capabilities: ['video'] });
    expect(byName('HM Studio 渠道').baseUrl).toBe(baseUrl);
    const model = db.select().from(models).where(eq(models.modelId, 'hm-url-regression')).get()!;
    AdminService.updateModel(model.id, { displayName: 'Renamed HM URL regression' });
    expect(byName('HM Studio 渠道').baseUrl).toBe(baseUrl);
    expect(byName('HM Studio 渠道').id).toBe(channel.id);
  });

  it('does not create an undiscovered MM PRO model or its price', () => {
    expect(db.select().from(models).where(eq(models.modelId, 'ZH-MMseadanco2.5-PRO')).get()).toBeUndefined();
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern, 'ZH-MMseadanco2.5-PRO')).get()).toBeUndefined();
  });
  it('fills an existing MM PRO model price at 4 per video on upgrade and preserves later admin edits', async () => {
    const modelId='ZH-MMseadanco2.5-PRO';
    db.insert(models).values({modelId,displayName:'PRO 自定义名称',provider:'zongheng',capabilities:'["video"]',isActive:0}).run();
    await initDatabase();
    const price=db.select().from(modelPricing).where(eq(modelPricing.modelPattern,modelId)).get()!;
    expect(price).toMatchObject({billingType:'per_call',inputPrice:4,outputPrice:0});
    expect(JSON.parse(price.extraParams)).toEqual({category:'video','720p':4});
    for(const seconds of [5,15,30]) expect(PricingService.quote(modelId,{resolution:'720p',seconds},false).cost).toBe(4);
    expect(db.select().from(models).where(eq(models.modelId,modelId)).get()).toMatchObject({displayName:'PRO 自定义名称',isActive:0});
    db.update(modelPricing).set({inputPrice:6,extraParams:JSON.stringify({category:'video','720p':6})}).where(eq(modelPricing.id,price.id)).run();
    await initDatabase();
    expect(PricingService.quote(modelId,{resolution:'720p',seconds:30},false).cost).toBe(6);
    db.delete(modelPricing).where(eq(modelPricing.id,price.id)).run();
    db.delete(models).where(eq(models.modelId,modelId)).run();
  });
  it('does not contact any upstream service during startup regression checks', () => {
    expect(network).not.toHaveBeenCalled();
  });
});
