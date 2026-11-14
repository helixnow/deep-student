import { CommandError, definePlugin } from '../host/kernel/api.ts';
import { toRfc3339 } from '../host/platform/time/index.ts';
import { exportUnifiedBackupData, type BackupLlmManager, type BackupSettingsStore } from './backup-export.ts';
import { BACKEND_SENTRY_SETTING, createBackendSentry, defaultSentryInit, installCrashCapture, type SentryLog } from './backend-sentry.ts';
import { APP_ROOT, appBuildInfo, bundledSentryDsn, getAppVersion, sentryRelease } from './build-info.ts';
import {
  copyFile,
  getFileSize,
  hashFile,
  readFileBytes,
  readFileText,
  saveTextToFile,
  type FileOperationDeps,
} from './file-ops.ts';
import { parseExternalOpenMode } from './external-file.ts';
import { checkPdfStreamAccess } from './pdfstream-access.ts';
import { createPowerGuard } from './power.ts';
import { encodeRawBytes } from './raw-bytes.ts';
import { createStartupGate } from './startup-gate.ts';
import { createSystemNotificationService, type SettingsReader } from './system-notification.ts';
import { openSystemPermissionSettings } from './system-permissions.ts';
import { loadWebviewSettings, saveWebviewSettings } from './webview-settings.ts';
import { createShellWindows } from './window-catalog.ts';

const appError = (error_type: string, message: string) => new CommandError({ error_type, message, details: null });

interface AppDirsReply { data?: string | null; localData?: string | null; cache?: string | null }
interface StorageLike { locations?: { activeDir?: string } }

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default definePlugin({
  meta: {
    id: 'dstu.shell', lane: 'F2-shell', provides: ['startupGate', 'systemNotification', 'shellWindows'],
    commands: ['get_app_version', 'get_app_data_dir', 'install_apk', 'open_file_externally', 'set_android_immersive_mode', 'updater_install_supported', 'open_system_permission_settings', 'get_prevent_sleep', 'set_prevent_sleep', 'set_sidebar_vibrancy', 'copy_file', 'get_file_size', 'hash_file', 'read_file_bytes', 'read_file_text', 'save_text_to_file', 'set_window_appearance', 'sync_titlebar_sidebar_material', 'save_webview_settings', 'load_webview_settings', 'pdfstream_check_access', 'export_unified_backup_data', 'set_backend_sentry_enabled'],
  },
  apply(ctx) {
    const build = appBuildInfo();
    const fullVersion = getAppVersion(build);
    // RUST-FIX(RF-W06-startup-recovery): 首次真实就绪经 Host 私有端口报告外壳。
    const gate = createStartupGate(() => {
      void ctx.shell.request('app.startupReady', {}).catch((error) => {
        ctx.logger('dstu.shell').warn(`Cannot record startup readiness: ${errorMessage(error)}`);
      });
    });
    ctx.provide('startupGate', gate);
    ctx.provide('shellWindows', createShellWindows(ctx.shell));
    // Rust `dstu_agent::system_notification` + `app.notification().show()` 的 Host 侧服务面；
    // 策略读取失败按 background（与 Rust current_policy 一致），投递失败不伪造送达回执。
    const systemNotification = createSystemNotificationService({
      settings: () => (ctx.get('settings') as SettingsReader | undefined) ?? null,
      mainWindowActive: async () => (await ctx.shell.request<unknown>('app.mainWindowActive', {})) === true,
      show: async (options) => { await ctx.shell.request('plugin:notification|notify', { options }); },
    });
    ctx.provide('systemNotification', systemNotification);
    const power = createPowerGuard(ctx.app.platform, ctx.logger('deep_student_lib::cmd::power'));
    ctx.effect(() => () => power.set(false));
    const fileDeps: FileOperationDeps = {
      platform: ctx.app.platform,
      appDirs: async () => {
        const reply = await ctx.shell.request<AppDirsReply>('app.dataDirs', {});
        return [reply.data, reply.localData, reply.cache].filter((dir): dir is string => typeof dir === 'string' && dir !== '');
      },
    };
    const webviewDeps = {
      platform: ctx.app.platform,
      dataDir: async () => {
        const storage = ctx.get('storage') as StorageLike | undefined;
        return storage?.locations?.activeDir ?? ctx.app.dataDir;
      },
    };
    const settingsStore: BackupSettingsStore = {
      listByPrefix: (prefix) => {
        const settings = ctx.get('settings') as BackupSettingsStore | undefined;
        if (!settings) throw new Error('settings service is not available');
        return settings.listByPrefix(prefix);
      },
    };
    const sentryLog: SentryLog = (level, message) => ctx.logger('deep_student_lib')[level](message);
    const sentry = createBackendSentry({
      settings: {
        save: (key, value) => {
          const settings = ctx.get('settings') as { save(k: string, v: string): void } | undefined;
          if (!settings) throw new Error('settings service is not available');
          settings.save(key, value);
        },
      },
      log: sentryLog,
      init: defaultSentryInit({ log: sentryLog, release: sentryRelease(build), debug: ctx.app.debug, bundledDsn: bundledSentryDsn() }),
      platform: ctx.app.platform,
      appRoot: APP_ROOT,
    });
    ctx.effect(() => {
      const uninstall = installCrashCapture(sentry);
      return async () => {
        uninstall();
        await sentry.dispose();
      };
    });
    // 设置服务不可用（例如数据恢复模式）时不启动，与 Rust 在恢复模式提前返回、不读授权一致；外壳插件本身不依赖它。
    ctx.inject(['settings'], (linked) => {
      void sentry.restore(() => linked.settings.get(BACKEND_SENTRY_SETTING));
    });
    ctx.commands.register('get_app_version', () => fullVersion);
    ctx.commands.register('get_app_data_dir', () => ctx.app.dataDir);
    ctx.commands.register('install_apk', () => { throw appError('Unknown', 'install_apk is only supported on Android'); });
    ctx.commands.register('open_file_externally', ({ mode }) => {
      parseExternalOpenMode(mode as string | null);
      throw appError('Validation', 'open_file_externally is only supported on Android');
    });
    ctx.commands.register('set_android_immersive_mode', () => null);
    ctx.commands.register('updater_install_supported', () => ctx.app.platform !== 'linux' || process.env.APPIMAGE !== undefined);
    ctx.commands.register('open_system_permission_settings', async ({ permission }) => {
      try { await openSystemPermissionSettings(permission as 'notifications' | 'microphone', ctx.app.platform, (message) => ctx.logger('dstu.shell').warn(message)); }
      catch (e) { throw new CommandError(typeof e === 'string' ? e : String(e)); }
      return null;
    });
    ctx.commands.register('get_prevent_sleep', () => power.get());
    ctx.commands.register('set_prevent_sleep', async ({ enabled }) => {
      try { return await power.set(enabled as boolean); }
      catch (e) { throw new CommandError(typeof e === 'string' ? e : String(e)); }
    });
    ctx.commands.register('set_sidebar_vibrancy', async ({ enabled }, call) => {
      if (ctx.app.platform !== 'darwin') return false;
      try { return await ctx.shell.request('window.setVibrancy', { enabled, __window: call.source.window }); }
      catch (e) { throw appError('Unknown', e instanceof Error ? e.message : String(e)); }
    });
    ctx.commands.register('read_file_text', ({ path }) => readFileText(path as string, fileDeps));
    ctx.commands.register('read_file_bytes', async ({ path, maxBytes }) => {
      const bytes = await readFileBytes(path as string, maxBytes as number | null, fileDeps);
      return encodeRawBytes(bytes);
    });
    ctx.commands.register('get_file_size', ({ path }) => getFileSize(path as string, fileDeps));
    ctx.commands.register('hash_file', ({ path }) => hashFile(path as string, fileDeps));
    ctx.commands.register('copy_file', ({ sourcePath, destPath }) => copyFile(sourcePath as string, destPath as string, fileDeps));
    ctx.commands.register('save_text_to_file', ({ path, content }) => saveTextToFile(path as string, content as string, fileDeps));
    ctx.commands.register('set_window_appearance', async ({ dark }, call) => {
      // Rust 非 macOS 分支：no-op。
      if (ctx.app.platform !== 'darwin') return null;
      try { await ctx.shell.request('window.setAppearance', { dark, __window: call.source.window }); }
      catch (error) { throw appError('Unknown', errorMessage(error)); }
      return null;
    });
    ctx.commands.register('sync_titlebar_sidebar_material', async ({ enabled, width }, call) => {
      if (ctx.app.platform !== 'darwin') return null;
      try { await ctx.shell.request('window.syncTitlebarSidebarMaterial', { enabled, width, __window: call.source.window }); }
      catch (error) { throw appError('Unknown', errorMessage(error)); }
      return null;
    });
    ctx.commands.register('save_webview_settings', ({ settings }) => saveWebviewSettings(settings, webviewDeps));
    ctx.commands.register('load_webview_settings', () => loadWebviewSettings(webviewDeps));
    ctx.commands.register('pdfstream_check_access', async ({ path }) => {
      try {
        const allowed = await ctx.shell.request<string[]>('app.pdfStreamAllowedDirs', {});
        const vfs = ctx.get('vfsDatabase') as { blobsDir(): string } | undefined;
        if (vfs) allowed.push(vfs.blobsDir());
        return checkPdfStreamAccess(path as string, allowed, ctx.app.platform);
      } catch (error) {
        throw appError('Unknown', errorMessage(error));
      }
    });
    ctx.commands.register('export_unified_backup_data', ({ options }) => exportUnifiedBackupData(options, {
      settings: settingsStore,
      llm: (ctx.get('llm') as BackupLlmManager | undefined) ?? null,
      now: () => toRfc3339(),
    }));
    ctx.commands.register('set_backend_sentry_enabled', ({ enabled }) => sentry.setEnabled(enabled as boolean));
  },
});
