import {
  LEGACY_SANDBOX_OWNER_KEY,
  SANDBOX_OWNER_ATTRIBUTE,
  useSandboxWorkbenchStore,
} from './store/useSandboxWorkbenchStore';
import type { SandboxOwnerKey, SandboxSessionInput } from './types';

function findOwnerFromActiveElement(): SandboxOwnerKey | undefined {
  if (typeof document === 'undefined') return undefined;
  const activeElement = document.activeElement;
  if (!(activeElement instanceof Element)) return undefined;
  const ownerHost = activeElement.closest(`[${SANDBOX_OWNER_ATTRIBUTE}]`);
  return ownerHost?.getAttribute(SANDBOX_OWNER_ATTRIBUTE)?.trim() || undefined;
}

export function launchSandboxWorkbench(
  input: SandboxSessionInput,
  ownerKey?: SandboxOwnerKey,
): void {
  const state = useSandboxWorkbenchStore.getState();
  // Pointer/focus capture updates activeOwnerKey before CodeBlock's click handler.
  // Prefer it over document.activeElement, which can remain in another window on WebKit.
  const resolvedOwnerKey = ownerKey
    ?? (state.activeOwnerKey !== LEGACY_SANDBOX_OWNER_KEY
      ? state.activeOwnerKey
      : findOwnerFromActiveElement());
  state.openSession(input, resolvedOwnerKey);
}

export default launchSandboxWorkbench;
