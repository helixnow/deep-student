/**
 * The standard "Host plugin unavailable" panel for UI halves whose Host half is degraded (`ctx.ui.hostStatus`).
 * Loaded on demand; render it inside `<Suspense>`. Not part of the stable index (`@deepstudent/ui`) yet.
 */
import { lazy } from 'react';

export type { HostUnavailablePanelProps } from '@/components/system-status/HostUnavailablePanel';

export const HostUnavailablePanel = lazy(() => import('@/components/system-status/HostUnavailablePanel'));
