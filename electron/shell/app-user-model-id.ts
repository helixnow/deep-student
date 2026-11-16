/**
 * Windows AppUserModelID（AUMID）。
 *
 * Windows 用 AUMID 把系统通知归到某个应用：Toast 只在 AUMID 对应的开始菜单快捷方式存在时才显示，
 * 标题栏写的也是那个快捷方式的应用名。Electron 不主动设置时，打包版会退回到可执行文件派生的 ID，
 * 通知可能不出现，或者显示成「electron.app.Deep Student」。
 *
 * - 打包版：用应用标识 `com.deepstudent.app`。electron-builder 的 NSIS 安装器把同一个 `appId` 写进开始菜单
 *   快捷方式的 AUMID，两边一致通知才能显示（`electron-builder.config.cjs` 的 `appId` 与 `tauri.conf.json` 的
 *   `identifier` 由测试保证相同）。
 * - 开发态：Electron 文档建议用 `process.execPath`，这样未安装的开发进程也能弹通知。
 * - 其他平台：不需要（macOS 用 bundle id，Linux 用 desktop 文件），返回 null。
 *
 * 必须在 `app.whenReady()` 之前、创建任何 Notification 之前设置。
 */
export function appUserModelId(platform: NodeJS.Platform | string, isPackaged: boolean, identifier: string,
  execPath: string): string | null {
  if (platform !== 'win32') return null;
  return isPackaged ? identifier : execPath;
}

export interface AumidApp {
  isPackaged: boolean;
  setAppUserModelId(id: string): void;
}

/** 在 main 启动早期调用；返回实际设置的 AUMID（非 Windows 为 null）。 */
export function installAppUserModelId(app: AumidApp, platform: NodeJS.Platform | string, identifier: string,
  execPath: string): string | null {
  const id = appUserModelId(platform, app.isPackaged, identifier, execPath);
  if (id !== null) app.setAppUserModelId(id);
  return id;
}
