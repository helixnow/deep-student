type UnlistenFn = () => void;

function createAsyncNoopUnlisten(): Promise<UnlistenFn> {
  return Promise.resolve(() => undefined);
}

function createAsyncWindowStub() {
  const base: Record<string, any> = {
    minimize: async () => undefined,
    maximize: async () => undefined,
    unmaximize: async () => undefined,
    isMaximized: async () => false,
    close: async () => undefined,
    startDragging: async () => undefined,
    isFullscreen: async () => false,
    setFullscreen: async (_fullscreen: boolean) => undefined,
    listen: async () => createAsyncNoopUnlisten(),
    onFileDropEvent: async () => createAsyncNoopUnlisten(),
  };

  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      // Default: unknown APIs become async no-ops to keep tests resilient
      return async () => undefined;
    },
  });
}

const currentWindow = createAsyncWindowStub();

export function getCurrentWindow() {
  return currentWindow;
}

export const appWindow = currentWindow;

export class WebviewWindow {
  static getCurrent() {
    const base: Record<string, any> = {
      isDevtoolsOpen: async () => false,
      openDevtools: async () => undefined,
      closeDevtools: async () => undefined,
      toggleDevtools: async () => undefined,
      listen: async () => createAsyncNoopUnlisten(),
      emit: async () => undefined,
    };

    return new Proxy(base, {
      get(target, prop) {
        if (prop in target) return (target as any)[prop];
        return async () => undefined;
      },
    });
  }
}

export default { getCurrentWindow, appWindow, WebviewWindow };
