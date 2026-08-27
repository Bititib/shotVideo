export type SuccessRateResult = {
  rate: number;
  estimated: boolean;
  sampleSize: number;
};

/**
 * Prevent tiny or empty samples from presenting misleading 0%/100% extremes.
 * Once enough recent terminal samples exist, the observed rate is returned.
 */
export function calculateSuccessRate(
  successCount: number,
  failureCount: number,
  options: {
    baseline?: number;
    priorWeight?: number;
    minimumSamples?: number;
    estimatedMin?: number;
    estimatedMax?: number;
  } = {},
): SuccessRateResult {
  const success = Math.max(0, Math.floor(successCount));
  const failure = Math.max(0, Math.floor(failureCount));
  const sampleSize = success + failure;
  const baseline = options.baseline ?? 60;
  const priorWeight = options.priorWeight ?? 10;
  const minimumSamples = options.minimumSamples ?? 10;
  const estimatedMin = options.estimatedMin ?? 50;
  const estimatedMax = options.estimatedMax ?? 70;

  if (sampleSize < minimumSamples) {
    const smoothed = ((success + (baseline / 100) * priorWeight) / (sampleSize + priorWeight)) * 100;
    return {
      rate: Number(Math.max(estimatedMin, Math.min(estimatedMax, smoothed)).toFixed(1)),
      estimated: true,
      sampleSize,
    };
  }

  return {
    rate: Number(((success / sampleSize) * 100).toFixed(1)),
    estimated: false,
    sampleSize,
  };
}

export function isWithinRecentDays(createdAt: string | null | undefined, days = 30, now = Date.now()): boolean {
  if (!createdAt) return false;
  const normalized = createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T') + 'Z';
  const timestamp = new Date(normalized).getTime();
  return Number.isFinite(timestamp) && timestamp >= now - days * 24 * 60 * 60 * 1000;
}
