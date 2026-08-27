import { describe, expect, it } from 'vitest';
import { getBillingUnit } from '../client/src/utils/billing.js';
import { shouldRemoveMissingGoogleModel } from '../server/db/seed.js';

describe('billing display', () => {
  it('uses the configured billing type instead of a model-name allowlist', () => {
    expect(getBillingUnit('per_call')).toBe('/次');
    expect(getBillingUnit('per_second')).toBe('/秒');
  });
});

describe('model synchronization ownership', () => {
  const verified = new Set(['gemini-current']);

  it('removes only missing Google models', () => {
    expect(shouldRemoveMissingGoogleModel({ provider: 'google', modelId: 'gemini-old' }, verified)).toBe(true);
    expect(shouldRemoveMissingGoogleModel({ provider: 'google', modelId: 'gemini-current' }, verified)).toBe(false);
  });

  it('preserves HM Studio and administrator-managed models', () => {
    expect(shouldRemoveMissingGoogleModel({ provider: 'hmstudio', modelId: 'seedance_v2.5' }, verified)).toBe(false);
    expect(shouldRemoveMissingGoogleModel({ provider: 'other', modelId: 'manual-model' }, verified)).toBe(false);
  });
});
