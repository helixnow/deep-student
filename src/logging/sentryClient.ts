/**
 * Named re-export facade for `@sentry/browser`.
 *
 * `await import('@sentry/browser')` in `src/main.tsx` forces Rollup to preserve the entire
 * namespace export object, pulling unused Replay (~313 KiB raw) and Feedback (~76 KiB raw)
 * bundles. Importing this facade instead enables tree-shaking down to the four APIs used.
 */
export {
  init,
  captureException,
  getClient,
  browserTracingIntegration,
} from '@sentry/browser';
