/**
 * 沙箱工作台应用注册（P9）
 *
 * instanceMode 决策：`useSandboxWorkbenchStore` 是全局单 activeSession store
 * （openSession 直接覆盖当前会话），多窗会互相踩会话 → single。
 * 若未来 store 升级为 by-workspaceId 多会话，再切 multi（instanceKey=workspaceId）。
 */
import React from 'react';
import { CodeBlock } from '@phosphor-icons/react';
import { appRegistry } from '../../core/appRegistry';

let registered = false;

/** 幂等注册沙箱工作台应用 */
export function registerSandboxApp(): void {
  if (registered) return;
  registered = true;

  appRegistry.register({
    typeId: 'sandbox',
    nameKey: 'workbench:apps.sandbox',
    icon: <CodeBlock size={26} weight="duotone" />,
    instanceMode: 'single',
    memoryWeight: 2,
    defaultFrame: { w: 960, h: 680 },
    minSize: { w: 560, h: 420 },
    render: React.lazy(() => import('./SandboxAppWindow')),
  });
}
