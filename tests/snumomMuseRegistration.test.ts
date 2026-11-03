import { expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
vi.mock('../server/db/index.js', async () => (await import('./helpers/memoryDatabase.js')).createMemoryDatabase());
vi.mock('../server/config/env.js',()=>({env:{NODE_ENV:'test',GEMINI_API_KEY:'',GEMINI_API_BASE_URL:'https://google.invalid',HM_STUDIO_API_KEY:'',WX_HAIDIYUE_API_KEY:'',MINGFEI_API_KEY:'',NEWTOKEN_BASE_URL:'https://newtoken.invalid',NEWTOKEN_API_KEY:'',SNUMOM_BASE_URL:'https://snumom.com',SNUMOM_API_KEY:'',ADMIN_EMAIL:'muse@test.invalid',ADMIN_PASSWORD:'test-only-password'},getApiKeys:()=>[]}));
import { initDatabase } from '../server/db/seed';
import { db, sqlite } from '../server/db/index';
import { models, modelPricing, channels, users } from '../server/db/schema';

it('Muse seed preserves administrator prices, activation, names, credentials and historical funds across repeated startup',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('network disabled');}));
  for(const name of ['SI_YUE_TIAN_API_KEY','PIDOI_IMAGE_API_KEY','MJNEWAPI_API_KEY','JULUN_API_KEY'])vi.stubEnv(name,'');
  try {
    await initDatabase();
    const id='muse-video';
    expect(db.select().from(models).where(eq(models.modelId,id)).get()).toMatchObject({isActive:0,provider:'snumom'});
    expect(db.select().from(modelPricing).where(eq(modelPricing.modelPattern,id)).get()).toBeUndefined();
    db.update(models).set({isActive:1,displayName:'operator Muse'}).where(eq(models.modelId,id)).run();
    db.insert(modelPricing).values({modelPattern:id,billingType:'per_call',inputPrice:7.25}).run();
    db.update(users).set({balance:123.45}).run();
    db.update(channels).set({apiKey:'operator-key',status:0,modelMapping:JSON.stringify({[id]:'operator-mapped-id'})}).where(eq(channels.type,'snumom')).run();
    const snapshot=()=>({balances:sqlite.prepare('SELECT id,balance FROM users').all(),prices:sqlite.prepare('SELECT model_pattern,billing_type,input_price,output_price,extra_params FROM model_pricing ORDER BY model_pattern').all(),...Object.fromEntries(['api_tokens','contents','fund_ledger'].map(t=>[t,sqlite.prepare('SELECT * FROM '+t).all()]))});
    const before=snapshot();await initDatabase();await initDatabase();
    expect(snapshot()).toEqual(before);
    expect(db.select().from(models).where(eq(models.modelId,id)).get()).toMatchObject({isActive:1,displayName:'operator Muse'});
    expect(db.select().from(channels).where(eq(channels.type,'snumom')).get()).toMatchObject({apiKey:'operator-key',status:0});
    expect(JSON.parse(db.select().from(channels).where(eq(channels.type,'snumom')).get()!.modelMapping)).toHaveProperty(id,'operator-mapped-id');
  } finally {vi.unstubAllGlobals();vi.unstubAllEnvs();sqlite.close();}
});
