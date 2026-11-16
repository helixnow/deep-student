/**
 * 让用户选文件 / 存文件（B15）：插件的 UI 半调用系统对话框，用户选中的路径随之放行，插件随后可以读写它。
 *
 * - `pick` / `pickFolder` 返回用户选中的绝对路径；用户取消时返回 `[]` / `null`，不抛错；
 * - `readText` / `readBytes` 读用户选中的文件（或其所在文件夹里的文件）；
 * - `saveText` / `saveBytes` 先弹「另存为」再写入，返回最终路径，取消时返回 `null`；
 * - 路径也可以交给插件的 Host 半（`ctx.ui.host.<服务>.<方法>(path)`）用 Node 处理大文件。
 *
 * 手机端没有文件夹选择器：`pickFolder` 在手机上抛错。
 */

export interface PluginFileFilter {
  /** 显示给用户的名字，例如「表格」。 */
  name: string;
  /** 不带点的扩展名，例如 `['csv', 'xlsx']`。 */
  extensions: string[];
}

export interface PluginPickOptions {
  title?: string;
  defaultPath?: string;
  filters?: PluginFileFilter[];
  /** 允许一次选多个文件，默认 false。 */
  multiple?: boolean;
}

export interface PluginSaveOptions {
  title?: string;
  /** 建议的文件名，例如 `今日总结.md`。 */
  defaultFileName?: string;
  defaultPath?: string;
  filters?: PluginFileFilter[];
}

export interface PluginFiles {
  pick(options?: PluginPickOptions): Promise<string[]>;
  pickFolder(options?: { title?: string; defaultPath?: string }): Promise<string | null>;
  readText(path: string): Promise<string>;
  readBytes(path: string): Promise<Uint8Array>;
  saveText(content: string, options?: PluginSaveOptions): Promise<string | null>;
  saveBytes(data: Uint8Array, options?: PluginSaveOptions & { mimeType?: string }): Promise<string | null>;
}

const manager = () => import('@/utils/fileManager').then((module) => module.fileManager);

/** 系统文件对话框与读写（`@deepstudent/ui` 的 `pluginFiles`）。 */
export const pluginFiles: PluginFiles = {
  async pick(options = {}) {
    const files = await manager();
    if (options.multiple) return files.pickMultipleFiles({ ...options, multiple: true });
    const path = await files.pickSingleFile(options);
    return path ? [path] : [];
  },
  async pickFolder(options = {}) {
    return (await manager()).pickDirectory(options);
  },
  async readText(path) {
    return (await manager()).readTextFile(path);
  },
  async readBytes(path) {
    const { readFile } = await import('@tauri-apps/plugin-fs');
    return readFile(path);
  },
  async saveText(content, options = {}) {
    const result = await (await manager()).saveTextFile({ ...options, content });
    return result.canceled ? null : result.path ?? null;
  },
  async saveBytes(data, options = {}) {
    const result = await (await manager()).saveBinaryFile({ ...options, data });
    return result.canceled ? null : result.path ?? null;
  },
};
