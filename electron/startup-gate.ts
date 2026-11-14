import type { StartupGate } from './api.ts';

/** dstu-platform/startup_gate.rs: single, monotonic readiness flag. */
export function createStartupGate(onReady: () => void = () => {}): StartupGate {
  let ready = false;
  const waiters = new Set<() => void>();
  const gate: StartupGate = {
    markStartupReady() {
      // RUST-FIX(RF-W06-startup-recovery): 只把首次真实就绪通知外壳（连续失败计数复位）。
      if (ready) return;
      ready = true;
      onReady();
      for (const notify of waiters) notify();
      waiters.clear();
    },
    isStartupReady: () => ready,
    waitStartupReady(timeout) {
      if (ready) return Promise.resolve(true);
      return new Promise((resolve) => {
        const notify = () => { clearTimeout(timer); resolve(ready); };
        const timer = setTimeout(() => { waiters.delete(notify); resolve(false); }, timeout);
        waiters.add(notify);
      });
    },
    guard: () => ({ [Symbol.dispose]: () => gate.markStartupReady() }),
  };
  return gate;
}
