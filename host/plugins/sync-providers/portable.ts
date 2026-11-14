/**
 * Node-free subset of `sync-providers/api.ts` (E2EE error codes and pure predicates).
 */
export {
  CLOUD_RATE_LIMITED_CODE,
  SYNC_E2EE_DOWNGRADE_REJECTED_CODE,
  SYNC_E2EE_MARKER_CORRUPTED_CODE,
  SYNC_E2EE_MEMORY_PERSIST_FAILED_CODE,
  SYNC_E2EE_PASSWORD_REQUIRED_CODE,
  SYNC_E2EE_PLAINTEXT_LEGACY_REJECTED_CODE,
  SYNC_E2EE_WRONG_PASSWORD_CODE,
  ensureDownloadNotDegraded,
  isCloudRateLimited,
  syncE2eeError,
} from './src/mod.ts';
export type { DowngradeDecision } from './src/mod.ts';
