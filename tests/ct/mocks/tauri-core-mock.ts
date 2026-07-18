export const invoke = async (command: string, _payload?: Record<string, unknown>) => {
  switch (command) {
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

/** 插件事件监听注册（返回空监听器） */
export const addPluginListener = async (_plugin: string, _event: string, _cb: unknown) => ({
  unregister: async () => {},
});

export default { invoke };
