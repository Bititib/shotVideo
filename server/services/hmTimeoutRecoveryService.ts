export type HmTimeoutRecoveryMetadata = Record<string, any>;

const HM_TASK_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseHmTimeoutRecoveryMetadata(value: unknown): HmTimeoutRecoveryMetadata {
  if (value && typeof value === 'object') return { ...(value as Record<string, any>) };
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function isHmTimedOutFailure(record: { status?: string; modelId?: string | null; metadata?: unknown }): boolean {
  const metadata = parseHmTimeoutRecoveryMetadata(record.metadata);
  return record.status === 'failed'
    && record.modelId === 'seedance_v2.5'
    && HM_TASK_ID_PATTERN.test(String(metadata.videoId || ''))
    && /video generation timed out/i.test(String(metadata.error || ''))
    && !metadata.recoveryChargedAt;
}

export function getHmTimeoutRecoveryCharge(metadataValue: unknown): number {
  const metadata = parseHmTimeoutRecoveryMetadata(metadataValue);
  const amount = Number(metadata.refundAmount);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}

export function buildHmTimeoutRecoveredMetadata(
  metadataValue: unknown,
  options: {
    localUrl: string;
    upstreamUrl: string;
    chargeAmount: number;
    chargeTarget: 'user_balance' | 'api_token' | 'not_charged';
    recoveredAt?: string;
  },
): HmTimeoutRecoveryMetadata {
  const metadata = parseHmTimeoutRecoveryMetadata(metadataValue);
  const recoveredAt = options.recoveredAt || new Date().toISOString();
  return {
    ...metadata,
    previousFailure: metadata.error || 'Video generation timed out',
    progress: 100,
    upstreamStatus: 'success',
    upstreamResultUrl: options.upstreamUrl,
    queueStatus: 'completed',
    queuePosition: 0,
    billingStatus: options.chargeAmount > 0 ? 'recharged_after_recovery' : 'not_charged',
    recoveryChargeAmount: options.chargeAmount,
    recoveryChargeTarget: options.chargeTarget,
    recoveryChargedAt: options.chargeAmount > 0 ? recoveredAt : undefined,
    recoveredFromTimeout: true,
    recoveredAt,
    localizedAt: recoveredAt,
    completedAt: recoveredAt,
    recoveryLocalUrl: options.localUrl,
    error: undefined,
    failedAt: undefined,
    recoveryAttemptId: undefined,
    recoveryStartedAt: undefined,
  };
}
