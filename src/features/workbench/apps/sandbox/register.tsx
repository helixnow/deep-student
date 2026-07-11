/**
 * 沙箱工作台应用注册（P9）
 *
 * instanceMode 决策：独立工作台固定绑定 standalone owner，产品上只需要一个
 * 宿主窗口；chat 内嵌预览使用各自 owner，不与该单例窗口共享活动指针。
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
