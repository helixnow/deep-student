/**
 * Settings services for other UI plugins: plugins import this module, never `src/features/settings/**`.
 *
 * `workbenchMode.setEnabled` is the one write path of the 学习桌面 switch. The deactivation precheck (every window's
 * canClose), persistence, the focus handoff to the classic shell and the `workbench:mode-changed` broadcast stay in the
 * settings feature (`features/settings/components/workbenchMode.ts`), which provides the implementation when its module
 * loads. The app loads that module at startup (`useWorkbenchMode`), so a call that arrives first waits for it.
 */

export interface WorkbenchModeService {
  /** Resolves false when nothing changed (a window refused to close, saving failed); the user has already been told. */
  setEnabled(enabled: boolean): Promise<boolean>;
}

let provided: WorkbenchModeService | null = null;
let waiting: ((service: WorkbenchModeService) => void)[] = [];

/** Called once by the settings feature; calls made before it are handed over in order. */
export function provideWorkbenchModeService(service: WorkbenchModeService): void {
  provided = service;
  const pending = waiting;
  waiting = [];
  for (const resume of pending) resume(service);
}

export const workbenchMode: WorkbenchModeService = {
  async setEnabled(enabled) {
    const service = provided ?? await new Promise<WorkbenchModeService>((resolve) => { waiting.push(resolve); });
    return service.setEnabled(enabled);
  },
};
