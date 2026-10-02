export type TtsVoice = { id: string; name: string; displayName?: string; gender?: string; style?: string; description?: string; scenario?: string; language?: string };
export const DEFAULT_TTS_CHARACTER_RATE = 1 / 1200;
export function ttsPriceLabel(rate: number): string {
  const rounded = Number(rate.toFixed(4));
  const approximate = Math.abs(rounded - rate) > 1e-12;
  return `${approximate ? '≈' : ''}¥${rounded.toLocaleString('en-US', { maximumFractionDigits: 4, useGrouping: false })}/字`;
}
// Only expose voice names returned by the configured upstream.
const EMPTY_TTS_VOICES: string[] = [];
export function ttsVoices(voices?: string[]): string[] {
  return voices?.length ? voices : EMPTY_TTS_VOICES;
}

export function audioExtension(mimeType = ''): string {
  const mime = mimeType.toLowerCase().split(';')[0];
  return ({ 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/ogg': 'ogg', 'audio/flac': 'flac' } as Record<string, string>)[mime] || 'wav';
}
