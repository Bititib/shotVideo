import { describe, expect, it } from 'vitest';
import { shouldRunHmFaceProcessing } from '../server/services/hmFaceProcessingService.js';

describe('HM server-side face processing switch', () => {
  it('stays off unless a real-person request explicitly enables it', () => {
    expect(shouldRunHmFaceProcessing(undefined, 'true')).toBe(false);
    expect(shouldRunHmFaceProcessing(false, 'true')).toBe(false);
    expect(shouldRunHmFaceProcessing('false', 'true')).toBe(false);
  });

  it('accepts boolean and multipart-style true values', () => {
    expect(shouldRunHmFaceProcessing(true, 'true')).toBe(true);
    expect(shouldRunHmFaceProcessing('true', 'true')).toBe(true);
    expect(shouldRunHmFaceProcessing('1', 'true')).toBe(true);
  });

  it('honors the server-wide kill switch', () => {
    expect(shouldRunHmFaceProcessing(true, 'false')).toBe(false);
    expect(shouldRunHmFaceProcessing('true', '0')).toBe(false);
  });
});
