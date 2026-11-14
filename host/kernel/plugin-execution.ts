/** Desktop execution attribution, not a physical isolation boundary. Kept out of portable runtime imports. */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Fiber } from '@deepseek-ai/cordis';
import type { PluginExecution } from './kernel.ts';

// RUST-FIX(RF-P1-managed-plugin-install): Execution-time caller survives awaits; object transfer cannot transfer this scope.
const callers = new AsyncLocalStorage<Fiber>();

export const pluginExecution: PluginExecution = {
  current: () => callers.getStore(),
  run: (fiber, callback) => callers.run(fiber, callback),
};
