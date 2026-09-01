import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getCachedVideoModels } from '../client/src/api/video.js';
import { getCachedImageModels } from '../client/src/api/imageGen.js';
import { getCachedAnalysisModels, getCachedTtsModels } from '../client/src/api/analysis.js';

const CACHE_KEY = 'video-models-cache-v1';
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => Array.from(values.keys())[index] ?? null,
    removeItem: key => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}

describe('video model persistent cache', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: createMemoryStorage(),
    });
  });

  afterEach(() => {
    if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    else delete (globalThis as any).localStorage;
  });

  it('returns the last valid public model list for instant rendering', () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: Date.now(),
      data: [{ id: 'video-model', name: 'Video Model', description: '', available: true }],
    }));

    expect(getCachedVideoModels()).toEqual([
      { id: 'video-model', name: 'Video Model', description: '', available: true },
    ]);
  });

  it('ignores expired or malformed cache data', () => {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      savedAt: Date.now() - 25 * 60 * 60 * 1000,
      data: [{ id: 'expired', name: 'Expired' }],
    }));
    expect(getCachedVideoModels()).toEqual([]);

    localStorage.setItem(CACHE_KEY, '{invalid');
    expect(getCachedVideoModels()).toEqual([]);
  });
});

describe('other model list persistent caches', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      value: createMemoryStorage(),
    });
  });

  afterEach(() => {
    if (originalLocalStorage) Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    else delete (globalThis as any).localStorage;
  });

  it('returns cached image models for immediate rendering', () => {
    localStorage.setItem('image-models-cache-v1', JSON.stringify({
      savedAt: Date.now(),
      data: [{ id: 'image-model', name: 'Image Model', description: '', available: true }],
    }));

    expect(getCachedImageModels()).toHaveLength(1);
    expect(getCachedImageModels()[0].id).toBe('image-model');
  });

  it('keeps account-specific analysis and TTS caches isolated by token', () => {
    localStorage.setItem('token', 'account-a');
    localStorage.setItem('analysis-models-cache-v1', JSON.stringify({
      token: 'account-a',
      savedAt: Date.now(),
      data: [{ modelId: 'analysis-model', displayName: 'Analysis Model' }],
    }));
    localStorage.setItem('tts-models-cache-v1', JSON.stringify({
      token: 'account-a',
      savedAt: Date.now(),
      data: [{ modelId: 'tts-model', displayName: 'TTS Model' }],
    }));

    expect(getCachedAnalysisModels()).toHaveLength(1);
    expect(getCachedTtsModels()).toHaveLength(1);

    localStorage.setItem('token', 'account-b');
    expect(getCachedAnalysisModels()).toEqual([]);
    expect(getCachedTtsModels()).toEqual([]);
  });
});
