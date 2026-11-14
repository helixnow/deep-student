/**
 * 主应用源码里的 @tauri-apps/api/core 在宣传片里指到这里（打包与类型检查都是）。
 * 没有后端：未登记的命令一律 reject，与主应用「非 Tauri 环境」的分支一致；
 * 需要组件自己取数的镜头用 mockInvoke 给某条命令登记固定返回值。
 * 导出面与原包一致：主应用按需加载的 Tauri 插件（updater、fs、global-shortcut……）也从这里取 Channel / Resource。
 */
type Handler = (args: unknown) => unknown;
const handlers = new Map<string, Handler>();

export const mockInvoke = (cmd: string, handler: Handler): void => {
  handlers.set(cmd, handler);
};

/** Node 版里多数后端服务经同一条命令调用（plugin:host|call），按「服务.方法」登记。 */
const HOST_CALL = 'plugin:host|call';
const hostHandlers = new Map<string, (args: unknown[]) => unknown>();

export const mockHostCall = (service: string, method: string, handler: (args: unknown[]) => unknown): void => {
  hostHandlers.set(`${service}.${method}`, handler);
};

handlers.set(HOST_CALL, (raw) => {
  const { service, method, args } = raw as { service: string; method: string; args?: unknown[] };
  const handler = hostHandlers.get(`${service}.${method}`);
  if (!handler) throw new Error(`[video] Host method "${service}.${method}" is unavailable in the Remotion bundle`);
  return handler(args ?? []);
});

export function invoke<T>(cmd: string, args?: unknown, _options?: unknown): Promise<T> {
  const handler = handlers.get(cmd);
  if (!handler) return Promise.reject(new Error(`[video] Tauri command "${cmd}" is unavailable in the Remotion bundle`));
  try {
    return Promise.resolve(handler(args) as T);
  } catch (error) {
    return Promise.reject(error);
  }
}

export const convertFileSrc = (filePath: string, _protocol?: string): string => filePath;
export const isTauri = (): boolean => false;

export const SERIALIZE_TO_IPC_FN = '__TAURI_TO_IPC_KEY__';
export const transformCallback = (_callback?: (response: unknown) => void, _once?: boolean): number => 0;

/** 没有后端往回推消息：通道只是一个占位对象。 */
export class Channel<T = unknown> {
  id = 0;
  onmessage: (response: T) => void;
  constructor(onmessage?: (response: T) => void) {
    this.onmessage = onmessage ?? (() => {});
  }
  toJSON(): string {
    return `__CHANNEL__:${this.id}`;
  }
}

export class Resource {
  readonly rid: number;
  constructor(rid: number) {
    this.rid = rid;
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

export class PluginListener {
  constructor(
    readonly plugin: string,
    readonly event: string,
    readonly channelId: number,
  ) {}
  unregister(): Promise<void> {
    return Promise.resolve();
  }
}

export const addPluginListener = (plugin: string, event: string, _cb: (payload: unknown) => void): Promise<PluginListener> =>
  Promise.resolve(new PluginListener(plugin, event, 0));

const noPermissions = (plugin: string) => Promise.reject(new Error(`[video] permissions of "${plugin}" are unavailable in the Remotion bundle`));
export const checkPermissions = <T,>(plugin: string): Promise<T> => noPermissions(plugin);
export const requestPermissions = <T,>(plugin: string): Promise<T> => noPermissions(plugin);
