import { afterEach, beforeEach, expect, it, vi } from 'vitest';

// 预热只在 App.tsx 模块求值期发生一次：每个用例重置模块表后重新求值真实 App.tsx，
// 只把 WorkbenchDesktop 换成计数桩，观察预热 import() 是否被发起。
const originalUrl = window.location.href;

async function countWorkbenchLoadsAt(search: string) {
  window.history.replaceState(null, '', `/${search}`);
  vi.resetModules();
  const loadWorkbench = vi.fn(() => ({ default: () => null }));
  vi.doMock('@/features/workbench/components/WorkbenchDesktop', loadWorkbench);
  await import('@/App');
  await vi.dynamicImportSettled();
  return loadWorkbench.mock.calls.length;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.doUnmock('@/features/workbench/components/WorkbenchDesktop');
  window.history.replaceState(null, '', originalUrl);
  localStorage.clear();
});

it('does not prewarm the Workbench chunk in the quick-assistant auxiliary window', async () => {
  expect(await countWorkbenchLoadsAt('?window=quick-assistant')).toBe(0);
}, 120_000);

it('still prewarms the Workbench chunk in the main window (no window parameter)', async () => {
  expect(await countWorkbenchLoadsAt('')).toBe(1);
}, 120_000);
