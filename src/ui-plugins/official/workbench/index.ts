import { defineUiPlugin } from '@/ui-kernel/kernel';
import { workbenchAppContributions } from '@/features/workbench/core/appContributions';
import { registerHostApp } from './hostApps';

/**
 * Workbench apps. The app definitions load with the Workbench chunk and announce themselves there
 * (`contributeWorkbenchApp`); this plugin contributes each one through `ctx.ui.workbench.registerApp`.
 * Apps that declare `hostPlugin` follow that Host plugin's status (`hostApps.tsx`).
 */
export default Object.assign(defineUiPlugin({
  meta: { id: 'dstu.ui.workbench', platforms: ['desktop'] },
  apply(ctx) {
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
