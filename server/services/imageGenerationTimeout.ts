export const DEFAULT_IMAGE_GENERATION_TIMEOUT_MS = 15 * 60_000;

/** Use the administrator's channel timeout for image creation, with a longer fallback. */
export function imageGenerationTimeout(channel?: { timeout?: unknown } | null): number {
  const configured = Number(channel?.timeout);
  return Number.isSafeInteger(configured) && configured > 0 && configured <= 2_147_483_647
    ? configured : DEFAULT_IMAGE_GENERATION_TIMEOUT_MS;
}
