export type CtInvokeHandler = (
  command: string,
  payload?: Record<string, unknown>,
) => unknown | Promise<unknown>;

interface CtInvokeCall {
  command: string;
  payload?: Record<string, unknown>;
}

interface CtInvokeState {
  handlers: Record<string, CtInvokeHandler>;
  calls: CtInvokeCall[];
}

/**
 * Page-local invoke fixture state.
 *
 * Playwright CT runs every test in a fresh page, so this module-level state is
 * naturally isolated per test. Harnesses configure it before mounting a
 * component; the app's own `invoke` import resolves to this same module via the
 * Vite alias in playwright-ct.config.ts.
 */
const ctInvokeState: CtInvokeState = {
  handlers: {},
  calls: [],
};

function exposeCalls(state: CtInvokeState) {
  if (typeof window === 'undefined') return;
  (window as unknown as Record<string, unknown>).__CT_INVOKE_CALLS__ = state.calls;
}

/** Install command handlers for one isolated CT page. */
export const setCtInvokeHandlers = (handlers: Record<string, CtInvokeHandler>) => {
  ctInvokeState.handlers = { ...handlers };
  ctInvokeState.calls = [];
  exposeCalls(ctInvokeState);
};

/** Drop all installed handlers and recorded calls. */
export const resetCtInvokeHandlers = () => {
  ctInvokeState.handlers = {};
  ctInvokeState.calls = [];
  exposeCalls(ctInvokeState);
};

/** Read back the calls recorded on this page (useful in page.evaluate). */
export const getCtInvokeCalls = (): CtInvokeCall[] => ctInvokeState.calls;

export const invoke = async (command: string, _payload?: Record<string, unknown>) => {
  ctInvokeState.calls.push({ command, payload: _payload });
  exposeCalls(ctInvokeState);

  const handler = ctInvokeState.handlers[command];
  if (handler) return handler(command, _payload);

  switch (command) {
    case 'qbank_list_authoring_drafts':
    case 'get_all_custom_templates':
      return [];
    case 'get_default_template_id':
      return null;
    case 'import_builtin_templates':
    case 'update_custom_template':
    default:
      return null;
  }
};

/** @tauri-apps/plugin-fs 等插件需要的 Resource 基类（空实现） */
export class Resource {
  rid: number;
  constructor(rid = 0) {
    this.rid = rid;
  }
  async close(): Promise<void> {}
}

/** 流式 IPC 通道（空实现：不产生任何消息） */
export class Channel<T = unknown> {
  onmessage?: (response: T) => void;
  constructor() {}
}

/** 部分插件用于注册回调并获取 rid */
export const transformCallback = (_callback?: (...args: unknown[]) => void): number => 0;

/** Tauri v2 asset URL helper（CT 环境无 IPC，直接回显原路径） */
export const convertFileSrc = (filePath: string, protocol = 'asset'): string =>
  `${protocol}://localhost/${String(filePath).replace(/^\/+/, '')}`;

/** 插件事件监听注册（返回空监听器） */
export const addPluginListener = async (_plugin: string, _event: string, _cb: unknown) => ({
  unregister: async () => {},
});

export default { invoke };
