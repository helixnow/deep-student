/** @tauri-apps/plugin-fs 的空实现：宣传片不写文件。 */
export const writeFile = (path: string, _data?: unknown, _options?: unknown): Promise<void> =>
  Promise.reject(new Error(`[video] writeFile("${path}") is unavailable in the Remotion bundle`));
