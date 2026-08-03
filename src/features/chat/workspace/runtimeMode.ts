/**
 * Temporary escape hatch for deployments that still require the frontend to
 * start worker pipelines. Runtime-managed execution is the default.
 */
export function isLegacyFrontendWorkerStartEnabled(runtimeManaged?: boolean): boolean {
  if (runtimeManaged === false) return true;
  return import.meta.env.VITE_WORKSPACE_LEGACY_FRONTEND_WORKER_START === 'true';
}
