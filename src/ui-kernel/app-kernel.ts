/**
 * The main window's kernel, for official UI halves that load after boot (e.g. the chat feature chunk)
 * and install their plugin once both sides are ready. Tests and secondary kernels never publish here.
 */
import type { UiKernel } from './kernel';

let appKernel: UiKernel | undefined;
const waiting = new Set<(kernel: UiKernel) => void>();

/** Called by bootstrap once the official plugins are installed. */
export function provideAppUiKernel(kernel: UiKernel | undefined): void {
  appKernel = kernel;
  if (!kernel) return;
  const listeners = [...waiting];
  waiting.clear();
  for (const listener of listeners) listener(kernel);
}

/** Runs `listener` with the app kernel now or once it is published; returns a cancel function. */
export function whenAppUiKernel(listener: (kernel: UiKernel) => void): () => void {
  if (appKernel) {
    listener(appKernel);
    return () => {};
  }
  waiting.add(listener);
  return () => void waiting.delete(listener);
}
