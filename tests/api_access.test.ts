import { describe, expect, it } from 'vitest';
import { canAccessVideoRecord, extractToken, filterRoutableModels, saveApiImageAssets } from '../server/routes/v1.js';
import { TokenService } from '../server/services/tokenService.js';
import { sqlite } from '../server/db/index.js';

describe('OpenAI-compatible API access', () => {
  it('accepts Authorization Bearer tokens', () => {
    expect(extractToken({ headers: { authorization: 'Bearer sk-bearer-token' } } as any))
      .toBe('sk-bearer-token');
  });

  it('accepts X-API-Key tokens', () => {
    expect(extractToken({ headers: { 'x-api-key': 'sk-header-token' } } as any))
      .toBe('sk-header-token');
  });

  it('prefers a valid Bearer token when both headers exist', () => {
    expect(extractToken({
      headers: {
        authorization: 'Bearer sk-bearer-token',
        'x-api-key': 'sk-header-token',
      },
    } as any)).toBe('sk-bearer-token');
  });

  it('only exposes models supported by active channels', () => {
    const result = filterRoutableModels(
      ['model-a', 'model-b', 'model-c'],
      [{ supportedModels: ['model-a'] }, { supportedModels: ['model-c'] }],
    );
    expect(result).toEqual(['model-a', 'model-c']);
  });

  it('allows all candidate models when an active wildcard channel exists', () => {
    const models = ['model-a', 'model-b'];
    expect(filterRoutableModels(models, [{ supportedModels: ['*'] }])).toEqual(models);
  });

  it('only allows the creating token to access a video task', () => {
    const record = { userId: 7, metadata: JSON.stringify({ tokenId: 12 }) };
    expect(canAccessVideoRecord(record, { id: 12, userId: 7 })).toBe(true);
    expect(canAccessVideoRecord(record, { id: 13, userId: 7 })).toBe(false);
  });

  it('uses the owning user for legacy video tasks without token metadata', () => {
    const record = { userId: 7, metadata: '{}' };
    expect(canAccessVideoRecord(record, { id: 12, userId: 7 })).toBe(true);
    expect(canAccessVideoRecord(record, { id: 12, userId: 8 })).toBe(false);
  });

  it('stores each API image as a separate content asset and preserves total cost', () => {
    const ids = saveApiImageAssets({
      token: { id: 77, userId: 1, name: 'asset-test-token' },
      responseBody: { data: [{ url: 'https://example.com/a.png' }, { url: 'https://example.com/b.png' }] },
      model: 'gpt-image-2',
      prompt: 'asset persistence test',
      size: '1024x1024',
      responseFormat: 'url',
      operation: 'generation',
      totalCost: 0.13,
    });

    try {
      expect(ids).toHaveLength(2);
      const placeholders = ids.map(() => '?').join(',');
      const rows = sqlite.prepare(`SELECT * FROM contents WHERE id IN (${placeholders}) ORDER BY id`).all(...ids) as any[];
      expect(rows).toHaveLength(2);
      expect(rows.every(row => row.type === 'image' && row.status === 'completed')).toBe(true);
      expect(rows.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(0.13, 2);
      expect(JSON.parse(rows[0].metadata).source).toBe('api');
    } finally {
      for (const id of ids) sqlite.prepare('DELETE FROM contents WHERE id = ?').run(id);
    }
  });

  it('never returns the full token key from list APIs', () => {
    const created = TokenService.createToken({ name: 'api-access-safe-list', balance: 1 });
    try {
      const listed = TokenService.getTokens({ search: 'api-access-safe-list' }).items[0] as any;
      expect(listed.tokenKey).toBeUndefined();
      expect(listed.tokenKeyMasked).toContain('****');
      expect(listed.tokenKeyMasked).not.toBe(created.tokenKey);
    } finally {
      sqlite.prepare('DELETE FROM api_tokens WHERE id = ?').run(created.id);
    }
  });
});
