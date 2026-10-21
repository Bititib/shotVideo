import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const probe = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: probe }));
vi.mock('node:fs/promises', () => ({ default: {
  writeFile: vi.fn(async () => {}), rm: vi.fn(async () => {}),
} }));
import { probeReferenceAudioSeconds, probeReferenceVideoSeconds } from '../server/services/videoDurationProbe.js';

beforeEach(() => {
  probe.mockReset().mockImplementation((_cmd, _args, _options, callback) => {
    callback(null, { stdout: JSON.stringify({ streams: [{ duration: '1.001' }], format: { duration: '1.001' } }) });
  });
});
afterEach(() => vi.restoreAllMocks());
it('rounds each audio up to a tenth and selects the audio stream', async () => {
  const result = await probeReferenceAudioSeconds(['data:audio/wav;base64,AQ==', 'data:audio/wav;base64,Ag==']);
  expect(result).toEqual({ rawDurations: [1.001, 1.001], durations: [1.1, 1.1], total: 2.2 });
  expect(probe.mock.calls[0][1]).toContain('a:0');
});
it('rejects missing audio streams, invalid duration and invalid input without caching errors', async () => {
  probe.mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, { stdout: '{"streams":[],"format":{"duration":"3"}}' }));
  await expect(probeReferenceAudioSeconds(['data:audio/wav;base64,Aw=='])).rejects.toThrow('音频流');
  probe.mockImplementationOnce((_cmd, _args, _options, callback) => callback(null, { stdout: '{"streams":[{}],"format":{"duration":"NaN"}}' }));
  await expect(probeReferenceAudioSeconds(['data:audio/wav;base64,BA=='])).rejects.toThrow('时长');
  await expect(probeReferenceAudioSeconds(['data:image/png;base64,AQ=='])).rejects.toThrow('格式');
});
it('preserves reference video rounding and video stream selection', async () => {
  expect(await probeReferenceVideoSeconds(['data:video/mp4;base64,BQ==']))
    .toMatchObject({ durations: [1.1], total: 1.1 });
  expect(probe.mock.calls[0][1]).toContain('v:0');
});
