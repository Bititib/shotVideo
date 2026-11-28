import type { TtsVoice } from '../../shared/tts.js';

/** Gemini TTS 官方预置音色（ai.google.dev 语音生成文档）。 */
export const GEMINI_PREBUILT_VOICES: TtsVoice[] = ([
  ['Zephyr', 'Bright'], ['Puck', 'Upbeat'], ['Charon', 'Informative'], ['Kore', 'Firm'], ['Fenrir', 'Excitable'],
  ['Leda', 'Youthful'], ['Orus', 'Firm'], ['Aoede', 'Breezy'], ['Callirrhoe', 'Easy-going'], ['Autonoe', 'Bright'],
  ['Enceladus', 'Breathy'], ['Iapetus', 'Clear'], ['Umbriel', 'Easy-going'], ['Algieba', 'Smooth'], ['Despina', 'Smooth'],
  ['Erinome', 'Clear'], ['Algenib', 'Gravelly'], ['Rasalgethi', 'Informative'], ['Laomedeia', 'Upbeat'], ['Achernar', 'Soft'],
  ['Alnilam', 'Firm'], ['Schedar', 'Even'], ['Gacrux', 'Mature'], ['Pulcherrima', 'Forward'], ['Achird', 'Friendly'],
  ['Zubenelgenubi', 'Casual'], ['Vindemiatrix', 'Gentle'], ['Sadachbia', 'Lively'], ['Sadaltager', 'Knowledgeable'], ['Sulafat', 'Warm'],
] as const).map(([id, style]) => ({ id, name: id, style }));

/** Some upstreams expose { voices: [{ id, name, ... }] } from /v1/voices. */
export function parseTtsVoices(payload: unknown): TtsVoice[] {
  const rows = (payload as { voices?: unknown })?.voices;
  if (!Array.isArray(rows)) throw new Error('Invalid upstream voice catalog');
  const seen = new Set<string>();
  return rows.flatMap(row => {
    if (!row || typeof row.id !== 'string' || !row.id.trim() || seen.has(row.id.trim())) return [];
    const id = row.id.trim(); seen.add(id);
    const voice: TtsVoice = { id, name: typeof row.name === 'string' ? row.name : id };
    for (const field of ['displayName', 'gender', 'style', 'description', 'scenario', 'language'] as const) {
      if (typeof row[field] === 'string') voice[field] = row[field];
    }
    return [voice];
  });
}

export function createTtsCatalogLoader() {
  let cache: { baseUrl: string; key: string; expires: number; data: TtsVoice[] } | undefined;
  let pending: { baseUrl: string; key: string; promise: Promise<TtsVoice[]> } | undefined;
  return async (baseUrl: string, key: string): Promise<TtsVoice[]> => {
    if (cache?.baseUrl === baseUrl && cache.key === key && cache.expires > Date.now()) return cache.data;
    if (pending?.baseUrl === baseUrl && pending.key === key) return pending.promise;
    const promise = (async () => {
      try {
        const response = await fetch(`${baseUrl.replace(/\/+$/, '')}/v1/voices`, {
          headers: { 'x-goog-api-key': key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000),
        });
        if (response.status === 404) {
          const data = GEMINI_PREBUILT_VOICES.map(voice => ({ ...voice }));
          cache = { baseUrl, key, expires: Date.now() + 5 * 60_000, data };
          return data;
        }
        if (!response.ok) throw new Error('Voice catalog unavailable');
        const data = parseTtsVoices(await response.json());
        cache = { baseUrl, key, expires: Date.now() + 5 * 60_000, data };
        return data;
      } catch {
        const data = cache?.baseUrl === baseUrl && cache.key === key ? cache.data : [];
        cache = { baseUrl, key, expires: Date.now() + 30_000, data };
        return data;
      }
    })();
    pending = { baseUrl, key, promise };
    try { return await promise; }
    finally { if (pending?.promise === promise) pending = undefined; }
  };
}

export const loadTtsVoiceCatalog = createTtsCatalogLoader();
