import { describe, expect, it } from 'vitest';
import {
  buildHmTimeoutRecoveredMetadata,
  getHmTimeoutRecoveryCharge,
  isHmTimedOutFailure,
} from '../server/services/hmTimeoutRecoveryService.js';

describe('HM timeout recovery', () => {
  const metadata = {
    videoId: '6cb783ef-e353-48bf-bd05-6fd4bd2c5d71',
    error: 'Video generation timed out after 30 minutes',
    refundAmount: 0.4,
    billingStatus: 'refunded',
    queueRefunded: true,
  };

  it('only selects failed HM timeout records with UUID task ids', () => {
    expect(isHmTimedOutFailure({ status: 'failed', modelId: 'seedance_v2.5', metadata })).toBe(true);
    expect(isHmTimedOutFailure({ status: 'completed', modelId: 'seedance_v2.5', metadata })).toBe(false);
    expect(isHmTimedOutFailure({
      status: 'failed',
      modelId: 'seedance_v2.5',
      metadata: { ...metadata, videoId: 'task_other_provider' },
    })).toBe(false);
  });

  it('uses the original refund amount for recovery charging', () => {
    expect(getHmTimeoutRecoveryCharge(metadata)).toBe(0.4);
    expect(getHmTimeoutRecoveryCharge({ refundAmount: 0 })).toBe(0);
  });

  it('preserves the old failure while marking a recovered task completed and recharged', () => {
    const recovered = buildHmTimeoutRecoveredMetadata(metadata, {
      localUrl: '/uploads/videos/recovered.mp4',
      upstreamUrl: 'https://cdn.test/result.mp4',
      chargeAmount: 0.4,
      chargeTarget: 'user_balance',
      recoveredAt: '2026-08-31T12:00:00.000Z',
    });
    expect(recovered).toMatchObject({
      progress: 100,
      upstreamStatus: 'success',
      queueStatus: 'completed',
      previousFailure: 'Video generation timed out after 30 minutes',
      billingStatus: 'recharged_after_recovery',
      recoveryChargeAmount: 0.4,
      recoveryChargeTarget: 'user_balance',
      recoveredFromTimeout: true,
      recoveredAt: '2026-08-31T12:00:00.000Z',
    });
    expect(recovered.error).toBeUndefined();
    expect(recovered.failedAt).toBeUndefined();
  });
});
