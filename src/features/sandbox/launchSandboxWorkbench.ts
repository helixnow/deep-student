import { useSandboxWorkbenchStore } from './store/useSandboxWorkbenchStore';
import type { SandboxSessionInput } from './types';

export function launchSandboxWorkbench(input: SandboxSessionInput): void {
  useSandboxWorkbenchStore.getState().openSession(input);
}

export default launchSandboxWorkbench;
