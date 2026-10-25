import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models, settings } from '../db/schema.js';
import { HUSS_BB_MODEL, hussBbModelLimits } from '../../shared/hussBbVideo.js';

const HUSS_BASE_URL = 'https://www.huss.top';
const HUSS_TYPE = 'huss';
const PUBLIC_BB_MODEL = 'bb-2.5-301010';
const ROUTES_KEY = 'model_specification_routes_v1';
const HEALTH_KEY = 'model_specification_health_v1';

// BlobDraw was replaced by HUSS. Keep the channel row (and its name) so the
// administrator can enter the new key in the same place, but never carry a
// former provider key or route into the new provider.
export function retireBlobDrawChannels(): number {
  const legacy = db.select().from(channels).where(eq(channels.type, 'blobdraw')).all();
  if (!legacy.length) return 0;
  const alreadyHuss = (baseUrl: string) => {
    try { const url = new URL(baseUrl); return url.protocol === 'https:' && ['huss.top', 'www.huss.top'].includes(url.hostname); }
    catch { return false; }
  };
  const ids = new Set(legacy.filter(row => !alreadyHuss(row.baseUrl)).map(row => row.id));

  sqlite.transaction(() => {
    for (const channel of legacy) {
      const { id } = channel;
      // The administrator already switched this row to HUSS: retain its key.
      if (alreadyHuss(channel.baseUrl)) {
        db.update(channels).set({ type: HUSS_TYPE, maxRetries: 0,
          modelMapping: JSON.stringify({ [PUBLIC_BB_MODEL]: HUSS_BB_MODEL }),
          supportedModels: JSON.stringify([PUBLIC_BB_MODEL]),
          updatedAt: new Date().toISOString() }).where(eq(channels.id, id)).run();
        continue;
      }
      db.update(channels).set({
        type: HUSS_TYPE,
        baseUrl: HUSS_BASE_URL,
        apiKey: '',
        modelMapping: '{}',
        supportedModels: '[]',
        maxRetries: 0,
        status: 0,
        lastTestAt: null,
        lastTestResult: '等待配置 HUSS API Key',
        updatedAt: new Date().toISOString(),
      }).where(eq(channels.id, id)).run();
    }

    const routesRow = db.select().from(settings).where(eq(settings.key, ROUTES_KEY)).get();
    if (routesRow) {
      try {
        const specs = JSON.parse(routesRow.value);
        if (Array.isArray(specs)) {
          const retained = specs.flatMap(spec => {
            const routes = Array.isArray(spec?.routes) ? spec.routes.filter((route: any) => !ids.has(route?.channelId)).map((route: any) => {
              const migrated = legacy.find(channel => channel.id === route.channelId && alreadyHuss(channel.baseUrl));
              if (!migrated || spec.modelId !== PUBLIC_BB_MODEL) return route;
              return { ...route, executionModel: PUBLIC_BB_MODEL, upstreamModel: HUSS_BB_MODEL,
                limits: route.upstreamModel === HUSS_BB_MODEL ? route.limits : hussBbModelLimits() };
            }) : [];
            return routes.length ? [{ ...spec, routes }] : [];
          });
          db.update(settings).set({ value: JSON.stringify(retained), updatedAt: new Date().toISOString() }).where(eq(settings.key, ROUTES_KEY)).run();
        }
      } catch { /* Leave a manually-corrupted setting untouched for admin repair. */ }
    }

    const healthRow = db.select().from(settings).where(eq(settings.key, HEALTH_KEY)).get();
    if (healthRow) {
      try {
        const health = JSON.parse(healthRow.value);
        if (health && typeof health === 'object' && !Array.isArray(health)) {
          for (const key of Object.keys(health)) if (ids.has(Number(key.split(':', 1)[0]))) delete health[key];
          db.update(settings).set({ value: JSON.stringify(health), updatedAt: new Date().toISOString() }).where(eq(settings.key, HEALTH_KEY)).run();
        }
      } catch { /* Leave a manually-corrupted setting untouched for admin repair. */ }
    }

    // The public model ID remains stable, but it must not stay enabled on an
    // old route while the HUSS channel is awaiting its new key and sync.
    const configured = db.select().from(channels).all().some(channel =>
      channel.type === HUSS_TYPE && channel.status === 1 && !!channel.apiKey && alreadyHuss(channel.baseUrl));
    db.update(models).set({ provider: HUSS_TYPE, ...(configured ? {} : { isActive: 0 }) })
      .where(eq(models.modelId, PUBLIC_BB_MODEL)).run();
  })();
  return legacy.length;
}
