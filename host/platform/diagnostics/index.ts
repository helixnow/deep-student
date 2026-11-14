import { definePlugin } from '../../kernel/api.ts';
import { createDiagnosticsService } from './package-manager.ts';
import { createBackgroundTasks } from './api.ts';
import { registerDatabaseCommands } from './database-commands.ts';
import { registerDevtoolsCommands } from './devtools.ts';

export default definePlugin({
  meta: { id: 'dstu.platform.diagnostics', lane: 'F4-security', provides: ['diagnostics', 'backgroundTasks'], commands: [
    'check_package_manager', 'check_all_package_managers', 'auto_install_package_manager',
    'debug_get_database_stats', 'debug_vfs_textbook_pages', 'debug_vfs_migration_status', 'write_test_report',
    'check_test_dependencies',
    'toggle_devtools',
  ] },
  inject: ['storage'],
  apply(ctx) {
    const service = createDiagnosticsService(ctx.logger);
    ctx.reflect.provide('diagnostics', service);
    const background = createBackgroundTasks(ctx.logger, ctx);
    ctx.reflect.provide('backgroundTasks', background);
    ctx.effect(() => () => background.shutdown());
    registerDatabaseCommands(ctx);
    registerDevtoolsCommands(ctx);
    ctx.commands.register('check_package_manager', async ({ command }) => {
      const info = await service.checkPackageManager(command as string);
      return info === null ? { detected: false, message: `无法识别命令 '${command}' 所需的包管理器` } : {
        detected: true, manager_type: info.manager_type, is_available: info.is_available, version: info.version,
        install_hints: info.install_hints, can_auto_install: info.install_command !== null,
      };
    });
    ctx.commands.register('check_all_package_managers', () => service.checkAllPackageManagers());
    ctx.commands.register('auto_install_package_manager', ({ managerType }) => service.autoInstallPackageManager(managerType as string));
  },
});
