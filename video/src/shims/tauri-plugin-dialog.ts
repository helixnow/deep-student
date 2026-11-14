/** @tauri-apps/plugin-dialog 的空实现：等同于用户在对话框里点了取消。 */
export const open = (_options?: unknown): Promise<null> => Promise.resolve(null);
export const save = (_options?: unknown): Promise<null> => Promise.resolve(null);
