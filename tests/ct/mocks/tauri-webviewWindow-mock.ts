type UnlistenFn = () => void;

function createAsyncNoopUnlisten(): Promise<UnlistenFn> {
  return Promise.resolve(() => undefined);
}

function createWebviewWindowStub() {
  const base: Record<string, any> = {
    listen: async () => createAsyncNoopUnlisten(),
    emit: async () => undefined,
    setFocus: async () => undefined,
  };

  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      return async () => undefined;
    },
  });
}

const currentWebviewWindow = createWebviewWindowStub();

export function getCurrentWebviewWindow() {
  return currentWebviewWindow;
}

export class WebviewWindow {
  static getCurrent() {
    return currentWebviewWindow;
  }
}

export default { getCurrentWebviewWindow, WebviewWindow };
