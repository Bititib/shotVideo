import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db/index.js';
import { channels, models, settings } from '../db/schema.js';

const HUSS_BASE_URL = 'https://www.huss.top';
const HUSS_TYPE = 'huss';
const PUBLIC_BB_MODEL = 'bb-2.5-301010';
const ROUTES_KEY = 'model_specification_routes_v1';
const HEALTH_KEY = 'model_specification_health_v1';

// BlobDraw was replaced by HUSS. Keep the channel row (and its name) so the
// administrator can enter the new key in the same place, but never carry a
// former provider key or route into the new provider.
export function retireBlobDrawChannels(): number {
  const legacy = db.select({ id: channels.id }).from(channels).where(eq(channels.type, 'blobdraw')).all();
  if (!legacy.length) return 0;
  const ids = new Set(legacy.map(row => row.id));

  sqlite.transaction(() => {
    for (const { id } of legacy) {
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
            const routes = Array.isArray(spec?.routes) ? spec.routes.filter((route: any) => !ids.has(route?.channelId)) : [];
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
    db.update(models).set({ provider: HUSS_TYPE, isActive: 0 }).where(eq(models.modelId, PUBLIC_BB_MODEL)).run();
  })();
  return legacy.length;
}
