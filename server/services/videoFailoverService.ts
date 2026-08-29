export const HM_STUDIO_PRIMARY_VIDEO_MODEL = 'seedance_v2.5';
export const MJ_OVERFLOW_VIDEO_MODEL = 'xd-seedance-2.5-720p';

export type HmStudioOverflowInput = {
  requestedModel: string;
  resolution: string;
  seconds: number;
  imageCount: number;
  videoCount: number;
  audioCount: number;
};

/**
 * The MJ overflow model is deliberately narrower than HM Studio: it accepts
 * at most nine reference images and no video/audio references. Never discard
 * user-provided material just to make a request eligible for failover.
 */
export function canUseMjOverflowModel(input: HmStudioOverflowInput): boolean {
  return input.requestedModel === HM_STUDIO_PRIMARY_VIDEO_MODEL
    && input.resolution === '720p'
    && Number.isInteger(input.seconds)
    && input.seconds >= 4
    && input.seconds <= 30
    && input.imageCount <= 9
    && input.videoCount === 0
    && input.audioCount === 0;
}

export function shouldOverflowHmStudio(input: HmStudioOverflowInput & {
  poolLoad: number;
  poolLimit: number;
  userLoad: number;
  userLimit: number;
  fallbackAvailable: boolean;
}): boolean {
  return input.fallbackAvailable
    && ((input.poolLimit > 0 && input.poolLoad >= input.poolLimit)
      || (input.userLimit > 0 && input.userLoad >= input.userLimit))
    && canUseMjOverflowModel(input);
}

/** Only submission-stage capacity errors are safe to retry on another channel. */
export function isHmStudioConcurrencyError(status: number, detail: string): boolean {
  if (status < 400 || status > 599) return false;
  return /并发|限流|频繁|排队已满|concurren|rate\s*limit|too\s*many|capacity|busy/i.test(detail);
}
