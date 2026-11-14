import { Suspense, createElement, lazy, useCallback, useEffect, useSyncExternalStore, type FC } from 'react';
import { useTranslation } from 'react-i18next';
import type { UiDisposer, UiHostStatusHandle, UiWorkbenchApp } from '@/ui-sdk';
import { HostUnavailablePanel } from '@/ui-sdk/host-unavailable';

type AppWindowProps = Parameters<UiWorkbenchApp['render']>[0];

/** Degradation reason (possibly empty) while `hostId` is degraded, otherwise null. */
function useDegradedReason(status: UiHostStatusHandle, hostId: string): string | null {
  const subscribe = useCallback((onChange: () => void) => status.subscribe(onChange), [status]);
  return useSyncExternalStore(subscribe, () => (status.state(hostId) === 'degraded' ? status.reason(hostId) ?? '' : null));
}

/**
 * The app's window, switching to the Host unavailable panel while `def.hostPlugin` is degraded. The switch happens
 * inside the window because the workbench keeps the definition an open window was created with.
 */
export function hostGatedRender(def: UiWorkbenchApp, hostId: string, status: UiHostStatusHandle): UiWorkbenchApp['render'] {
  const App = def.render;
  const HostGatedAppWindow: FC<AppWindowProps> = (props) => {
    const { t } = useTranslation();
    const reason = useDegradedReason(status, hostId);
    const { onTitleChange } = props;
    useEffect(() => {
      if (reason !== null) onTitleChange(t(def.nameKey));
    }, [reason, onTitleChange, t]);
    if (reason === null) return createElement(App, props);
    return createElement(Suspense, { fallback: null },
      createElement(HostUnavailablePanel, { hostId, titleKey: def.nameKey, reason: reason || undefined }));
  };
  return lazy(async () => ({ default: HostGatedAppWindow }));
}

/**
 * Registers an app that declares `hostPlugin`: absent from the workbench while that Host plugin is missing, registered
 * again (same gated definition) when it comes back. Unknown state counts as online. Revoked with the calling plugin.
 * A first registration failure throws; a later one (on the Host plugin's return) goes to `onError`.
 */
export function registerHostApp(
  def: UiWorkbenchApp & { hostPlugin: string },
  status: UiHostStatusHandle,
  register: (def: UiWorkbenchApp) => UiDisposer,
  onError: (error: unknown) => void,
): void {
  const gated: UiWorkbenchApp = { ...def, render: hostGatedRender(def, def.hostPlugin, status) };
  let revoke: UiDisposer | undefined;
  const sync = () => {
    const missing = status.state(def.hostPlugin) === 'missing';
    if (missing && revoke) {
      revoke();
      revoke = undefined;
    } else if (!missing && !revoke) {
      revoke = register(gated);
    }
  };
  sync();
  status.subscribe(() => {
    try {
      sync();
    } catch (error) {
      onError(error);
    }
  });
}
