/**
 * P3 窗口 chrome 测试共用工具：测试应用注册 + store 重置。
 */
import React from 'react';
import { appRegistry } from '@/features/workbench/core/appRegistry';
import { useWindowStore } from '@/features/workbench/core/windowStore';
import type { AppDefinition, AppWindowProps, OpenWindowInput } from '@/features/workbench/core/types';

export const TestApp: React.FC<AppWindowProps> = (props) => (
  <div
    data-testid="app-content"
    data-active={String(props.isActive)}
    data-visible={String(props.isVisible)}
  >
    <span>app:{props.windowId}</span>
    <button type="button" onClick={() => props.onTitleChange('新标题')}>
      set-title
    </button>
    <button type="button" onClick={() => props.requestClose()}>
      request-close
    </button>
  </div>
);

export function registerTestApp(
  typeId = 'test-app',
  overrides: Partial<AppDefinition> = {},
): void {
  appRegistry.register({
    typeId,
    nameKey: 'workbench:apps.test',
    icon: null,
    instanceMode: 'multi',
    memoryWeight: 1,
    defaultFrame: { w: 640, h: 480 },
    minSize: { w: 320, h: 240 },
    render: React.lazy(() => Promise.resolve({ default: TestApp })),
    ...overrides,
  });
}

export function resetWorkbenchStore(desktop = { w: 1600, h: 900 }): void {
  useWindowStore.setState({
    windows: {},
    focusStack: [],
    lifecycles: {},
    launchPayloads: {},
    tilingRatios: {},
    desktopSize: desktop,
  });
}

export function openTestWindow(
  input: Partial<OpenWindowInput> = {},
): string {
  return useWindowStore.getState().openWindow({ typeId: 'test-app', ...input });
}
