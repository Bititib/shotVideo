import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
import { db, sqlite } from '../server/db/index.js';
import { models, users, tiers, modelPricing, organizations } from '../server/db/schema.js';
import { ensureUserModelTables } from '../server/db/userModelMigration.js';
import { PricingService } from '../server/services/pricingService.js';
import { UserModelSettingsService } from '../server/services/userModelSettingsService.js';
import { assertUserModelAccess, filterUserModels } from '../server/services/userModelAccessService.js';
import { quoteVideoRequest } from '../server/services/videoQuoteService.js';
import { reserveUserCharge } from '../server/services/billingReservation.js';
import { tierMiddleware } from '../server/middleware/tier.js';
import { userModelMiddleware } from '../server/middleware/userModel.js';
import { resolvePublicModelId } from '../server/services/publicModelNameService.js';
import { VideoBatchStore } from '../server/services/videoBatchStore.js';
import { BalanceService } from '../server/services/balanceService.js';
import { eq } from 'drizzle-orm';

const modelId = 20;
const change = (inputPrice = .3, extras: Record<string, number> = { '720p': .35 }, userId = 1) => UserModelSettingsService.save(userId, modelId, 3, {
  accessMode: 'inherit', pricingMode: 'custom', customPrice: { billingType: 'per_second', inputPrice, outputPrice: 0, extraParams: extras },
});
beforeEach(() => {
  ensureUserModelTables(sqlite);
  sqlite.exec(`DELETE FROM user_model_access; DELETE FROM user_model_pricing; DELETE FROM user_model_audit;
    DELETE FROM model_pricing; DELETE FROM models; DELETE FROM users; DELETE FROM tiers; DELETE FROM settings; DELETE FROM tier_model_access;
    DROP TABLE IF EXISTS billing_reservations;`);
  db.insert(tiers).values({ id: 1, name: 'free', displayName: '免费', allowedFeatures: '["video","tts"]' }).run();
  for (const id of [1, 2, 3]) db.insert(users).values({ id, username: 'user' + id, email: `${id}@test.invalid`, passwordHash: 'test', balance: 100, tierId: 1, role: id === 3 ? 'super_admin' : 'user' }).run();
  db.insert(models).values({ id: modelId, modelId: 'user-price-video', displayName: '测试视频', capabilities: '["video"]' }).run();
  db.insert(modelPricing).values({ modelPattern: 'user-price-video', billingType: 'per_second', inputPrice: .5, extraParams: '{"720p":0.6,"1080p":0.8}' }).run();
});

describe('user model prices and access', () => {
  it('saves multiple models atomically and rolls back both prices and audit on validation failure', () => {
    db.insert(models).values({ id: 21, modelId: 'second-video', displayName: '视频二', capabilities: '["video"]' }).run();
    db.insert(modelPricing).values({ modelPattern: 'second-video', billingType: 'per_second', inputPrice: .5 }).run();
    const payload = { accessMode: 'allow', pricingMode: 'custom', customPrice: { billingType: 'per_second', inputPrice: .2, outputPrice: 0, extraParams: {} } };
    expect(() => UserModelSettingsService.saveMany(1, 3, [{ ...payload, modelId: 20 },
      { ...payload, modelId: 21, customPrice: { ...payload.customPrice, inputPrice: -1 } }])).toThrow();
    expect(sqlite.prepare('SELECT * FROM user_model_pricing').all()).toHaveLength(0);
    expect(sqlite.prepare('SELECT * FROM user_model_access').all()).toHaveLength(0);
    expect(sqlite.prepare('SELECT * FROM user_model_audit').all()).toHaveLength(0);
    const saved = UserModelSettingsService.saveMany(1, 3, [{ ...payload, modelId: 20 }, { ...payload, modelId: 21 }]);
    expect(saved).toHaveLength(2);
    expect(sqlite.prepare('SELECT * FROM user_model_audit').all()).toHaveLength(2);
    expect(() => UserModelSettingsService.saveMany(1, 3, [{ ...payload, modelId: 20 }, { ...payload, modelId: 20 }])).toThrow();
  });
  it('isolates users, model identities, public prices and global configuration', () => {
    change();
    expect(PricingService.quote('user-price-video', { seconds: 10, resolution: '720p' }, false, 1).cost).toBe(3.5);
    expect(PricingService.quote('user-price-video', { seconds: 10, resolution: '720p' }, false, 2).cost).toBe(6);
    expect(PricingService.quote('user-price-video', { seconds: 10, resolution: '720p' }, false, null).cost).toBe(6);
    expect(PricingService.getPublicPricingForModels(['user-price-video'], 1)[0]).toMatchObject({ unit_price: .3, resolution_prices: { '720p': .35 } });
    expect(PricingService.getPublicPricingForModels(['user-price-video'], 2)[0].unit_price).toBe(.5);
    expect(PricingService.quote('other-video', { seconds: 10 }, false, 1).billingType).toBeNull();
  });
  it('supports free prices, case-insensitive resolutions and custom base fallback', () => {
    change(0, { '720P': 0 });
    expect(PricingService.quote('user-price-video', { seconds: 10, resolution: '720p' }, false, 1).cost).toBe(0);
    expect(PricingService.quote('user-price-video', { seconds: 10, resolution: '1080p' }, false, 1).cost).toBe(0);
    expect(PricingService.quote('user-price-video', {}, false, 1).billingType).toBe('per_second');
  });
  it('quotes videos with the authenticated user and rejects a deny override', () => {
    change();
    expect(quoteVideoRequest({ model: 'user-price-video', seconds: 10, resolution: '720p' }, 1).cost).toBe(3.5);
    UserModelSettingsService.save(1, modelId, 3, { accessMode: 'deny', pricingMode: 'inherit' });
    expect(() => quoteVideoRequest({ model: 'user-price-video', seconds: 10, resolution: '720p' }, 1)).toThrow('禁止');
  });
  it('pins a reservation and resolver across repricing, deletion and partial refunds', () => {
    change();
    const resolver = PricingService.createQuoteResolver(false, 1);
    const quote = resolver('user-price-video', { seconds: 10, resolution: '720p' });
    const charge = reserveUserCharge(1, quote.cost, 'test', { pricingSnapshot: quote.pricingSnapshot });
    change(.9, { '720p': 1 });
    expect(resolver('user-price-video', { seconds: 10, resolution: '720p' }).cost).toBe(3.5);
    expect(PricingService.quote('user-price-video', { seconds: 10, resolution: '720p' }, false, 1).cost).toBe(10);
    const snapshot = JSON.parse((sqlite.prepare('SELECT context FROM billing_reservations WHERE id=?').get(charge.id) as any).context).pricingSnapshot;
    UserModelSettingsService.save(1, modelId, 3, { accessMode: 'inherit', pricingMode: 'inherit' });
    charge.settle(PricingService.quoteSnapshot(snapshot, { seconds: 5, resolution: '720p' }).cost);
    charge.cancel();
    expect(db.select().from(users).where(eq(users.id, 1)).get()!.balance).toBe(98.25);
    expect(snapshot).toMatchObject({ source: 'user', revision: 1, billingType: 'per_second' });
  });
  it('persists the original batch price separately from browser request parameters', () => {
    change();
    const quote = PricingService.quote('user-price-video', { seconds: 10, resolution: '720p' }, false, 1);
    const store = new VideoBatchStore(sqlite, {
      deduct: (id, amount) => BalanceService.deductWithSource(id, amount, 'test_batch'),
      refund: (id, amount, receipt) => { BalanceService.refundToSource(id, amount, receipt.source, receipt.orgId); },
    });
    const batch = store.create(1, 'price-pinned-batch', { name: 'test', model: 'user-price-video', video_length: 10, aspect_ratio: '16:9', resolution: '720p',
      autoRetry: false, maxRetries: 0, creatives: [{ prompt: 'test', count: 2 }] }, quote.cost, 'http://localhost', quote.pricingSnapshot);
    change(1, { '720p': 1 });
    const item = store.claim(store.detail(batch, 1).items[0].id);
    const context = store.context(item.id, item.attempts, 1);
    expect(context.body).not.toHaveProperty('pricingSnapshot');
    expect(PricingService.quoteSnapshot(context.pricingSnapshot).cost).toBe(3.5);
    expect(context.item.unit_cost).toBe(3.5);
    expect(BalanceService.getBalance(1)).toBe(93);
  });
  it('prices by the actor while refunding to the original organization wallet', () => {
    db.delete(organizations).run();
    db.insert(organizations).values({ id: 10, name: 'Test', slug: 'test', ownerId: 1, balance: 100 }).run();
    db.update(users).set({ orgId: 10 }).where(eq(users.id, 1)).run();
    change();
    const quote = PricingService.quote('user-price-video', { seconds: 10, resolution: '720p' }, false, 1);
    const charge = reserveUserCharge(1, quote.cost, 'test_org', { pricingSnapshot: quote.pricingSnapshot });
    expect(BalanceService.getOrgBalance(10)).toBe(96.5);
    db.update(users).set({ orgId: null }).where(eq(users.id, 1)).run();
    charge.cancel();
    expect(BalanceService.getOrgBalance(10)).toBe(100);
    expect(BalanceService.getBalance(1)).toBe(100);
  });
  it('preserves independent prices when the global price changes and restores defaults explicitly', () => {
    change();
    const rule = db.select().from(modelPricing).get()!;
    PricingService.updatePricingRule(rule.id, { inputPrice: 2 });
    expect(PricingService.quote('user-price-video', {}, false, 1).rate).toBe(.3);
    expect(() => PricingService.updatePricingRule(rule.id, { billingType: 'per_call' })).toThrow();
    UserModelSettingsService.save(1, modelId, 3, { accessMode: 'inherit', pricingMode: 'inherit' });
    expect(PricingService.quote('user-price-video', {}, false, 1).rate).toBe(2);
  });
  it('keeps the price after a model rename and shares the canonical alias identity', () => {
    change();
    sqlite.prepare('INSERT INTO settings(key,value) VALUES(?,?)').run('public_model_name_aliases_v1', JSON.stringify({ 'old-price-video': modelId }));
    db.update(models).set({ modelId: 'new-price-video' }).where(eq(models.id, modelId)).run();
    expect(PricingService.quote(resolvePublicModelId('old-price-video'), { seconds: 10 }, false, 1).cost).toBe(3);
  });
  it.each([-1, NaN, Infinity, '', '0', null])('rejects invalid base prices (%s) without partial access changes', value => {
    expect(() => UserModelSettingsService.save(1, modelId, 3, { accessMode: 'allow', pricingMode: 'custom',
      customPrice: { billingType: 'per_second', inputPrice: value, outputPrice: 0, extraParams: {} } })).toThrow();
    expect(sqlite.prepare('SELECT * FROM user_model_access').all()).toHaveLength(0);
    expect(sqlite.prepare('SELECT * FROM user_model_pricing').all()).toHaveLength(0);
  });
  it('rejects changed units, invalid resolution prices and stale edits', () => {
    change();
    const payload = { accessMode: 'inherit', pricingMode: 'custom', customPrice: { billingType: 'per_second', inputPrice: .2, outputPrice: 0, extraParams: {} } };
    expect(() => UserModelSettingsService.save(1, modelId, 3, { ...payload, expectedRevision: null })).toThrow('其他管理员');
    expect(() => UserModelSettingsService.save(1, modelId, 3, { ...payload, customPrice: { ...payload.customPrice, billingType: 'per_call' } })).toThrow('计费单位');
    expect(() => UserModelSettingsService.save(1, modelId, 3, { ...payload, customPrice: { ...payload.customPrice, extraParams: { '720p': -1 } } })).toThrow('分辨率');
    expect(sqlite.prepare('SELECT * FROM user_model_audit').all()).toHaveLength(1);
  });
  it('keeps price configuration separate from access and adds tier-level allow overrides', () => {
    change();
    const candidates = db.select().from(models).all();
    expect(filterUserModels(1, candidates, [])).toHaveLength(0);
    UserModelSettingsService.save(1, modelId, 3, { accessMode: 'allow', pricingMode: 'inherit' });
    expect(filterUserModels(1, candidates, [])).toHaveLength(1);
    const req: any = { userId: 1 };
    tierMiddleware('video')(req, {} as any, () => {});
    expect(req.availableModels.map((m: any) => m.modelId)).toEqual(['user-price-video']);
    UserModelSettingsService.save(1, modelId, 3, { accessMode: 'deny', pricingMode: 'inherit' });
    expect(() => assertUserModelAccess(1, 'user-price-video')).toThrow();
    expect(filterUserModels(1, candidates)).toHaveLength(0);
    expect(filterUserModels(2, candidates)).toHaveLength(1);
  });
  it('enforces deny overrides against direct and default media requests', () => {
    UserModelSettingsService.save(1, modelId, 3, { accessMode: 'deny', pricingMode: 'inherit' });
    for (const body of [{ model: 'user-price-video' }, {}]) {
      const res: any = { status: vi.fn().mockReturnThis(), json: vi.fn() }, next = vi.fn();
      userModelMiddleware('user-price-video')({ userId: 1, body } as any, res, next);
      expect(res.status).toHaveBeenCalledWith(403); expect(next).not.toHaveBeenCalled();
    }
  });
  it('supports token input/output, calls and characters with the same override', () => {
    for (const [billingType, usage, expected] of [
      ['per_token', { promptTokens: 1_000_000, completionTokens: 2_000_000 }, 7],
      ['per_call', { count: 3 }, 3], ['per_character', { characters: 20 }, 20],
    ] as const) {
      sqlite.exec('DELETE FROM user_model_pricing');
      db.update(models).set({ capabilities: billingType === 'per_token' ? '["text"]' : billingType === 'per_call' ? '["image"]' : '["tts"]' }).where(eq(models.id, modelId)).run();
      db.update(modelPricing).set({ billingType }).run();
      UserModelSettingsService.save(1, modelId, 3, { accessMode: 'inherit', pricingMode: 'custom', customPrice: { billingType, inputPrice: 1, outputPrice: 3, extraParams: {} } });
      expect(PricingService.quote('user-price-video', usage, false, 1).cost).toBe(expected);
    }
  });
});
