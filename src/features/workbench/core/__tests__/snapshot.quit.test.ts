import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
let listeners: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  invoke.mockReset();
  Object.assign(window, { __TAURI_INTERNALS__: {} });
  listeners = vi.spyOn(window, 'addEventListener');
});
afterEach(() => {
  for (const [name, listener] of listeners.mock.calls) {
    if (name === 'workbench:before-quit') window.removeEventListener(name, listener);
  }
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function requestQuit() {
  const detail = { pending: null as Promise<void> | null };
  window.dispatchEvent(new CustomEvent('workbench:before-quit', { detail }));
  expect(detail.pending).toBeInstanceOf(Promise);
  return detail.pending!;
}

it('quit before the debounce expires persists the latest layout and awaits the Host reply', async () => {
  const snapshot = await import('../snapshot');
  let finish!: () => void;
  invoke.mockImplementation(() => new Promise<void>((resolve) => { finish = resolve; }));
  snapshot.registerDockPinnedProvider(() => ['latest']);
  snapshot.saveSnapshot();
  await vi.advanceTimersByTimeAsync(100);
  expect(invoke).not.toHaveBeenCalled();
  const quitting = requestQuit();
  let finished = false;
  void quitting.then(() => { finished = true; });
  expect(JSON.parse(invoke.mock.calls[0][1].value).dockPinned).toEqual(['latest']);
  await Promise.resolve();
  expect(finished).toBe(false);
  finish();
  await quitting;
  // pagehide / duplicate quit does not send another save after Host shutdown.
  await snapshot.flushSnapshot();
  await requestQuit();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(invoke).toHaveBeenCalledTimes(1);
  // A cancelled close must not disable future saves.
  invoke.mockResolvedValue(undefined);
  snapshot.registerDockPinnedProvider(() => ['after-cancel']);
  snapshot.saveSnapshot();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('quit waits for an in-flight older write, then commits the latest pending metadata', async () => {
  const snapshot = await import('../snapshot');
  const completions: Array<() => void> = [];
  invoke.mockImplementation(() => new Promise<void>((resolve) => completions.push(resolve)));
  snapshot.registerDockPinnedProvider(() => ['old']);
  snapshot.saveSnapshot();
  await vi.advanceTimersByTimeAsync(2_000);
  snapshot.registerDockPinnedProvider(() => ['new']);
  snapshot.saveSnapshot('meta');
  const quitting = requestQuit();
  expect(invoke).toHaveBeenCalledTimes(1);
  completions[0]();
  await vi.advanceTimersByTimeAsync(0);
  expect(invoke).toHaveBeenCalledTimes(2);
  expect(JSON.parse(invoke.mock.calls[1][1].value).dockPinned).toEqual(['new']);
  completions[1]();
  await quitting;
  await vi.advanceTimersByTimeAsync(10_000);
  expect(invoke).toHaveBeenCalledTimes(2);
});

it('an imported but idle workbench does not replace a previously saved layout', async () => {
  await import('../snapshot');
  await requestQuit();
  expect(invoke).not.toHaveBeenCalled();
});
