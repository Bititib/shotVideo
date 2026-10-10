import { defineConfig } from 'vitest/config';
// Opt-in legacy channel regression suite. All database access is isolated in memory.
export default defineConfig({ test: {
  globals: true, environment: 'node', testTimeout: 30000, hookTimeout: 120000,
  setupFiles: ['tests/legacyChannelIsolation.setup.ts'],
  include: [
    'tests/zongheng*.test.ts', 'tests/hayaIntegration.test.ts', 'tests/prechargeRoutes.test.ts',
    'tests/videoRecoveryService.test.ts', 'tests/longxiaIntegration.test.ts',
    'tests/miaowuChannelConfig.test.ts', 'tests/channel_api_keys.test.ts',
    'tests/contentRoutingPrivacy.test.ts', 'tests/videoBatchRoutes.test.ts', 'tests/modelCatalog.test.ts',
  ],
} });
