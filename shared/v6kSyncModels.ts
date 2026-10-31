/** Only these explicitly requested new-site models may be added by automatic channel sync. */
export const V6K_SYNC_UPSTREAM_MODELS = [
  'TTTseadanco2.5/720',
  'Asedanco2.0',
  'Asedanco2.05',
  'XXsedanco2.0',
  'TTseadanco2.5-480',
  'TTseadanco2.5-720',
  'TTseadanco2.5-1080',
] as const;

const allowed = new Set<string>(V6K_SYNC_UPSTREAM_MODELS);
export function isV6kSyncModel(id: string): boolean { return allowed.has(id); }
