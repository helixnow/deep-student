type UnlistenFn = () => void;

type DragDropEventPayload =
  | { type: 'enter'; paths?: string[] }
  | { type: 'leave' }
  | { type: 'drop'; paths?: string[] };

type DragDropEvent = { payload: DragDropEventPayload };

function createAsyncNoopUnlisten(): Promise<UnlistenFn> {
  return Promise.resolve(() => undefined);
}

function createWebviewStub() {
  const base: Record<string, any> = {
    // Tauri v2 drag & drop API
    onDragDropEvent: async (_handler: (event: DragDropEvent) => void) => createAsyncNoopUnlisten(),
    // Used by Settings zoom control
    setZoom: async (_scale: number) => undefined,
  };

  return new Proxy(base, {
    get(target, prop) {
      if (prop in target) return (target as any)[prop];
      return async () => undefined;
    },
  });
}

const currentWebview = createWebviewStub();

export function getCurrentWebview() {
  // `await getCurrentWebview()` should also work in app code
  return currentWebview;
}

export default { getCurrentWebview };
