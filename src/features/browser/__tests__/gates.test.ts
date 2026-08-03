/**
 * Browser 双闸：父闸缺失键必须遵循 resolveWorkbenchModeEnabled 默认 true，
 * 不得按裸 `=== 'true'` 把缺失当成关闭。
 *
 * 纯函数半边对齐 Rust `assert_settings_gates_open`；async 路径覆盖迁移副作用。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, notifyMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(async (_cmd: string, _payload?: Record<string, unknown>) => null as unknown),
  notifyMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));
vi.mock('@/components/UnifiedNotification', () => ({
  showGlobalNotification: (...args: unknown[]) => notifyMock(...args),
}));

import {
  WORKBENCH_MODE_MIGRATED_KEY,
  WORKBENCH_MODE_SETTING_KEY,
  __resetWorkbenchModeCacheForTest,
} from '@/features/settings/components/workbenchMode';
import { BROWSER_SETTING_KEYS } from '../navigationPolicy';
import {
  assertBrowserGatesOpen,
  BrowserGateClosedError,
  evaluateBrowserSettingsGates,
  interpretBrowserChildGateEnabled,
  resolveBrowserGates,
} from '../gates';

function mockSettingsStore(initial?: Record<string, string>) {
  const store = new Map<string, string>(Object.entries(initial ?? {}));
  invokeMock.mockImplementation(async (cmd: string, payload?: Record<string, unknown>) => {
    if (cmd === 'get_setting') {
      return store.get(String(payload?.key)) ?? null;
    }
    if (cmd === 'save_setting') {
      store.set(String(payload?.key), String(payload?.value));
      return null;
    }
    return null;
  });
  return store;
}

describe('evaluateBrowserSettingsGates（对齐 Rust assert_settings_gates_open）', () => {
  it('父闸缺失 + 子闸 true → 开放', () => {
    const g = evaluateBrowserSettingsGates(null, 'true');
    expect(g).toMatchObject({
      workbenchModeEnabled: true,
      browserEnabled: true,
      open: true,
      closeMessage: null,
    });
    expect(evaluateBrowserSettingsGates(undefined, 'true').open).toBe(true);
    expect(evaluateBrowserSettingsGates('', 'true').open).toBe(true);
    expect(evaluateBrowserSettingsGates('  ', 'true').open).toBe(true);
  });

  it('父闸显式 false → 关（即使子闸 true）', () => {
    const g = evaluateBrowserSettingsGates('false', 'true');
    expect(g.open).toBe(false);
    expect(g.workbenchModeEnabled).toBe(false);
    expect(g.closeMessage).toBe('browser disabled: desktop.workbenchMode is off');
    expect(evaluateBrowserSettingsGates('  false  ', 'true').open).toBe(false);
  });

  it('子闸仍 opt-in：缺失 / false → 关', () => {
    expect(evaluateBrowserSettingsGates(null, null).open).toBe(false);
    expect(evaluateBrowserSettingsGates(null, null).closeMessage).toBe(
      'browser disabled: desktop.workbenchBrowserEnabled is off',
    );
    expect(evaluateBrowserSettingsGates('true', 'false').open).toBe(false);
    expect(interpretBrowserChildGateEnabled(null)).toBe(false);
    expect(interpretBrowserChildGateEnabled('TRUE')).toBe(true);
    expect(interpretBrowserChildGateEnabled('1')).toBe(true);
    expect(interpretBrowserChildGateEnabled('yes')).toBe(true);
    expect(interpretBrowserChildGateEnabled('on')).toBe(true);
    expect(interpretBrowserChildGateEnabled('false')).toBe(false);
  });
});

describe('resolveBrowserGates', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    notifyMock.mockReset();
    __resetWorkbenchModeCacheForTest();
  });

  it('desktop.workbenchMode 键缺失 → 父闸默认 true（并迁移），子闸仍需显式 true', async () => {
    const store = mockSettingsStore();

    const gates = await resolveBrowserGates();

    expect(gates.workbenchModeEnabled).toBe(true);
    expect(gates.browserEnabled).toBe(false);
    expect(gates.open).toBe(false);
    expect(store.get(WORKBENCH_MODE_SETTING_KEY)).toBe('true');
    expect(store.get(WORKBENCH_MODE_MIGRATED_KEY)).toBe('true');
  });

  it('父闸缺失 + 子闸显式 true → 双闸开放（不因父闸缺失误关）', async () => {
    mockSettingsStore({
      [BROWSER_SETTING_KEYS.enabled]: 'true',
    });

    const gates = await resolveBrowserGates();

    expect(gates.workbenchModeEnabled).toBe(true);
    expect(gates.browserEnabled).toBe(true);
    expect(gates.open).toBe(true);
    await expect(assertBrowserGatesOpen()).resolves.toMatchObject({ open: true });
  });

  it('显式关闭父闸 → assert 拒绝（与缺失默认相反）', async () => {
    mockSettingsStore({
      [WORKBENCH_MODE_SETTING_KEY]: 'false',
      [BROWSER_SETTING_KEYS.enabled]: 'true',
    });

    const gates = await resolveBrowserGates();
    expect(gates.workbenchModeEnabled).toBe(false);
    expect(gates.open).toBe(false);

    await expect(assertBrowserGatesOpen()).rejects.toBeInstanceOf(BrowserGateClosedError);
    await expect(assertBrowserGatesOpen()).rejects.toMatchObject({
      message: expect.stringContaining('desktop.workbenchMode'),
    });
  });

  it('父闸开、子闸缺失 → 子闸关闭（opt-in 语义不变）', async () => {
    mockSettingsStore({
      [WORKBENCH_MODE_SETTING_KEY]: 'true',
    });

    const gates = await resolveBrowserGates();
    expect(gates.workbenchModeEnabled).toBe(true);
    expect(gates.browserEnabled).toBe(false);
    expect(gates.open).toBe(false);
    await expect(assertBrowserGatesOpen()).rejects.toMatchObject({
      message: expect.stringContaining('desktop.workbenchBrowserEnabled'),
    });
  });
});
