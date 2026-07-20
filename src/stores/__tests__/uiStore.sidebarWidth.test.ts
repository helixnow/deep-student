import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { DESKTOP_SHELL } from '@/app/shell/desktopShell';

const storage = new Map<string, string>();

vi.stubGlobal('localStorage', {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
  removeItem: (key: string) => storage.delete(key),
  clear: () => storage.clear(),
  key: (index: number) => [...storage.keys()][index] ?? null,
  get length() {
    return storage.size;
  },
});

let useUIStore: typeof import('../uiStore')['useUIStore'];
let migratePersistedUIState: ((persistedState: unknown, version: number) => unknown) | undefined;

describe('uiStore desktop sidebar width', () => {
  beforeAll(async () => {
    const uiStoreModule = await import('../uiStore');
    useUIStore = uiStoreModule.useUIStore;
    migratePersistedUIState = (
      uiStoreModule as typeof uiStoreModule & {
        migratePersistedUIState?: (persistedState: unknown, version: number) => unknown;
      }
    ).migratePersistedUIState;
  });

  beforeEach(() => {
    useUIStore.setState({
      leftPanelCollapsed: false,
      leftPanelWidth: DESKTOP_SHELL.navigationWidth,
    });
  });

  it('starts from the default expanded width', () => {
    expect(useUIStore.getState().leftPanelWidth).toBe(DESKTOP_SHELL.navigationWidth);
  });

  it('updates expanded width without changing collapsed state', () => {
    useUIStore.setState({ leftPanelCollapsed: true });

    useUIStore.getState().setLeftPanelWidth(348);

    expect(useUIStore.getState()).toMatchObject({
      leftPanelCollapsed: true,
      leftPanelWidth: 348,
    });
  });

  it('migrates the legacy 272px default without changing custom widths', () => {
    expect(migratePersistedUIState).toBeTypeOf('function');
    if (!migratePersistedUIState) return;

    expect(migratePersistedUIState({ leftPanelCollapsed: false, leftPanelWidth: 272 }, 0)).toEqual({
      leftPanelCollapsed: false,
      leftPanelWidth: DESKTOP_SHELL.navigationWidth,
    });
    expect(migratePersistedUIState({ leftPanelCollapsed: false, leftPanelWidth: 348 }, 0)).toEqual({
      leftPanelCollapsed: false,
      leftPanelWidth: 348,
    });
  });
});
