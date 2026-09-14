import { describe, expect, it } from 'vitest';
import { shouldRunHmFaceProcessing } from '../server/services/hmFaceProcessingService.js';

describe('HM server-side face processing switch', () => {
  it('defaults to on when the request omits the parameter', () => {
    expect(shouldRunHmFaceProcessing(undefined, 'true')).toBe(true);
    expect(shouldRunHmFaceProcessing(null, 'true')).toBe(true);
    expect(shouldRunHmFaceProcessing('', 'true')).toBe(true);
  });

  it('allows a request to explicitly disable it', () => {
    expect(shouldRunHmFaceProcessing(false, 'true')).toBe(false);
    expect(shouldRunHmFaceProcessing('false', 'true')).toBe(false);
  });

  it('accepts boolean and multipart-style true values', () => {
    expect(shouldRunHmFaceProcessing(true, 'true')).toBe(true);
    expect(shouldRunHmFaceProcessing('true', 'true')).toBe(true);
    expect(shouldRunHmFaceProcessing('1', 'true')).toBe(true);
  });

  it('honors the server-wide kill switch', () => {
    expect(shouldRunHmFaceProcessing(undefined, 'false')).toBe(false);
    expect(shouldRunHmFaceProcessing(true, 'false')).toBe(false);
    expect(shouldRunHmFaceProcessing('true', '0')).toBe(false);
  });
});
