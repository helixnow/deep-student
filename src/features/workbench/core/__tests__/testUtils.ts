/**
 * P1 内核测试共享工具（非测试文件，不会被 vitest 收集）
 */
import type { AppDefinition, WorkbenchWindow } from '../types';
import { appRegistry } from '../appRegistry';

let seq = 0;

export function makeWin(partial: Partial<WorkbenchWindow> = {}): WorkbenchWindow {
  seq += 1;
  return {
    id: `win_${seq}`,
    typeId: 'test-app',
    instanceKey: null,
    title: '',
    frame: { x: 0, y: 0, w: 400, h: 300 },
    restoreFrame: null,
    displayMode: 'floating',
    minimized: false,
    zIndex: 100 + seq,
    createdAt: seq,
    lastFocusedAt: seq,
    ...partial,
  };
}

const registered = new Set<string>();

export function registerTestApp(
  typeId: string,
  overrides: Partial<Omit<AppDefinition, 'typeId'>> = {},
): void {
  if (registered.has(typeId)) return;
  registered.add(typeId);
  appRegistry.register({
    typeId,
    nameKey: `workbench:test.${typeId}`,
    icon: null,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 400, h: 300 },
    minSize: { w: 200, h: 150 },
    render: null as unknown as AppDefinition['render'],
    ...overrides,
  });
}
