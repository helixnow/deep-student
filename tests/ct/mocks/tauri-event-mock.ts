type CtEvent<T = unknown> = { event: string; id: number; payload: T };
type CtListener = (event: CtEvent) => void | Promise<void>;
const listeners = new Map<string, Set<CtListener>>();

export const listen = async <T>(event: string, listener: (event: CtEvent<T>) => void | Promise<void>) => {
  const registered = listeners.get(event) ?? new Set<CtListener>();
  registered.add(listener as CtListener);
  listeners.set(event, registered);
  return () => {
    registered.delete(listener as CtListener);
    if (!registered.size) listeners.delete(event);
  };
};

export const dispatchCtEvent = async <T>(event: string, payload: T) => {
  await Promise.all([...(listeners.get(event) ?? [])].map((listener) => listener({ event, id: 1, payload })));
};

export const ctListenerCount = (event: string) => listeners.get(event)?.size ?? 0;
export const emit = async () => undefined;
export const emitTo = async () => undefined;

export default { listen, emit, emitTo };







