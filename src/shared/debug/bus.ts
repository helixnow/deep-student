/**
 * Debug bus (FE-B7): business code reports to debug panels without importing them.
 *
 * A panel module serves a channel with its handlers (`serveDebugChannel`); business code calls the typed emitters of
 * `debugChannel(name)`. Production builds compile every emitter to a no-op and never reach the panel modules, so
 * `src/debug-panel/plugins/**` stays out of the bundle. In development, emits made before the panel module is
 * loaded are queued per channel (bounded) and replayed in order when it starts serving; queries (synchronous
 * helpers with a result, e.g. DOM capture) return `undefined` until then.
 */

type Handler = (...args: any[]) => unknown;
export type DebugChannelHandlers = Record<string, Handler>;

interface QueuedCall {
  op: string;
  args: unknown[];
}

const MAX_QUEUED = 500;
const servers = new Map<string, DebugChannelHandlers>();
const queues = new Map<string, QueuedCall[]>();

function deliver(channel: string, handlers: DebugChannelHandlers, op: string, args: unknown[]): unknown {
  try {
    return handlers[op]?.(...args);
  } catch (error) {
    console.warn(`[debug-bus] ${channel}.${op} failed:`, error);
    return undefined;
  }
}

export const debugBus = {
  /** Fire-and-forget report on `channel`; queued in development until a panel serves it. */
  emit(channel: string, op: string, ...args: unknown[]): void {
    if (!import.meta.env.DEV) return;
    const handlers = servers.get(channel);
    if (handlers) {
      deliver(channel, handlers, op, args);
      return;
    }
    const queue = queues.get(channel) ?? [];
    queue.push({ op, args });
    if (queue.length > MAX_QUEUED) queue.splice(0, queue.length - MAX_QUEUED);
    queues.set(channel, queue);
  },
  /** Synchronous call with a result; `undefined` while nobody serves `channel` and always in production. */
  query(channel: string, op: string, ...args: unknown[]): unknown {
    if (!import.meta.env.DEV) return undefined;
    const handlers = servers.get(channel);
    return handlers ? deliver(channel, handlers, op, args) : undefined;
  },
};

/** Serve `channel` from a panel module; replays the queued emits. Returns the function that stops serving. */
export function serveDebugChannel(channel: string, handlers: DebugChannelHandlers): () => void {
  if (!import.meta.env.DEV) return () => undefined;
  servers.set(channel, handlers);
  const queued = queues.get(channel) ?? [];
  queues.delete(channel);
  for (const { op, args } of queued) deliver(channel, handlers, op, args);
  return () => {
    if (servers.get(channel) === handlers) servers.delete(channel);
  };
}

/** Typed emitters / queries of one channel; `H` is the handler shape the serving panel implements. */
export function debugChannel<H extends DebugChannelHandlers>(channel: string) {
  return {
    emitter<K extends keyof H & string>(op: K): (...args: Parameters<H[K]>) => void {
      return (...args) => debugBus.emit(channel, op, ...args);
    },
    query<K extends keyof H & string>(op: K): (...args: Parameters<H[K]>) => ReturnType<H[K]> | undefined {
      return (...args) => debugBus.query(channel, op, ...args) as ReturnType<H[K]> | undefined;
    },
  };
}
