import { definePlugin } from '../../kernel/core.ts';
import { createBackgroundTasks, type DiagnosticsService } from './api.ts';

export function createMobileDiagnostics(): DiagnosticsService {
  return {
    async checkPackageManager() { return null; },
    async checkAllPackageManagers() { return {}; },
    async autoInstallPackageManager() {
      return { success: false, message: 'UNSUPPORTED_ON_PLATFORM: packageManager.install is not available on mobile', installed_version: null };
    },
  };
}

export default definePlugin({
  meta: { id: 'dstu.platform.diagnostics', provides: ['diagnostics', 'backgroundTasks'], platforms: ['mobile'] },
  apply(ctx) {
    ctx.reflect.provide('diagnostics', createMobileDiagnostics());
    const tasks = createBackgroundTasks(ctx.logger, ctx);
    ctx.reflect.provide('backgroundTasks', tasks);
    ctx.effect(() => () => tasks.shutdown());
  },
});
