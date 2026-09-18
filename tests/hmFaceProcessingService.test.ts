import { describe, expect, it } from 'vitest';
import path from 'path';
import { resolveHmLocalUploadPath, shouldRunHmFaceProcessing } from '../server/services/hmFaceProcessingService.js';

describe('HM server-side face processing switch', () => {
  it('keeps local processing globally disabled for every request value', () => {
    expect(shouldRunHmFaceProcessing(undefined, undefined)).toBe(false);
    expect(shouldRunHmFaceProcessing(undefined, 'true')).toBe(false);
    expect(shouldRunHmFaceProcessing(false, 'true')).toBe(false);
    expect(shouldRunHmFaceProcessing('false', 'true')).toBe(false);
    expect(shouldRunHmFaceProcessing(true, 'true')).toBe(false);
    expect(shouldRunHmFaceProcessing('true', 'true')).toBe(false);
    expect(shouldRunHmFaceProcessing('1', 'true')).toBe(false);
    expect(shouldRunHmFaceProcessing('true', '0')).toBe(false);
  });

  it('preserves history-assets when resolving local person images', () => {
    const expected = path.resolve(process.cwd(), 'data', 'uploads', 'history-assets', 'person.jpg');
    expect(resolveHmLocalUploadPath('/uploads/history-assets/person.jpg')).toBe(expected);
    expect(resolveHmLocalUploadPath(
      'https://video.example.com/uploads/history-assets/person.jpg?cache=1',
      'https://video.example.com',
    )).toBe(expected);
  });

  it('does not treat another origin as a local upload', () => {
    expect(resolveHmLocalUploadPath(
      'https://cdn.example.com/uploads/history-assets/person.jpg',
      'https://video.example.com',
    )).toBeNull();
  });
});
