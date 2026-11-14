/** @tauri-apps/api/event 的空实现：宣传片里没有事件总线，监听立即返回一个空的取消函数。 */
export type UnlistenFn = () => void;
const unlisten: UnlistenFn = () => {};

export const listen = (_event: string, _handler: unknown, _options?: unknown): Promise<UnlistenFn> => Promise.resolve(unlisten);
export const once = listen;
export const emit = (_event: string, _payload?: unknown): Promise<void> => Promise.resolve();
export const emitTo = (_target: unknown, _event: string, _payload?: unknown): Promise<void> => Promise.resolve();
