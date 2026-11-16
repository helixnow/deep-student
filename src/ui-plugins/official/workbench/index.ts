import { defineUiPlugin } from '@/ui-kernel/kernel';
import { workbenchAppContributions } from '@/features/workbench/core/appContributions';
import { registerHostApp } from './hostApps';

/**
 * Workbench apps. The app definitions load with the Workbench chunk and announce themselves there
 * (`contributeWorkbenchApp`); this plugin contributes each one through `ctx.ui.workbench.registerApp`.
 * Apps that declare `hostPlugin` follow that Host plugin's status (`hostApps.tsx`).
 * Also declares the desktop's `statusbar.items` and `desktop.widgets` slots (contracts/surfaces.ts).
 */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.workbench', platforms: ['desktop'], slots: ['statusbar.items', 'desktop.widgets'] },
  apply(ctx) {
    ctx.ui.declareSlot({ name: 'statusbar.items', cardinality: 'list', description: '工作台顶部状态栏（菜单栏）右侧的小项：component 收到 className（内置状态项样式）' });
    ctx.ui.declareSlot({ name: 'desktop.widgets', cardinality: 'list', description: '工作台桌面右上角小组件栏的卡片：title + size sm | md | lg（默认 md）+ component' });
    const hostStatus = ctx.ui.hostStatus;
    ctx.ui.attach(workbenchAppContributions, (def) => {
      const { hostPlugin } = def;
      if (hostPlugin) {
        registerHostApp({ ...def, hostPlugin }, hostStatus, (app) => ctx.ui.workbench.registerApp(app), (error) => ctx.ui.reportError(error));
      } else {
        ctx.ui.workbench.registerApp(def);
      }
    });
  },
}), { order: 50 });
