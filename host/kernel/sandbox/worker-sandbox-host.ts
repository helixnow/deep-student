/**
 * Concrete SandboxTransport adapters for MessagePort / Worker-like endpoints and
 * deterministic in-memory testing.
 *
 * 100% Node-free via structural typing: works seamlessly with Web standard
 * MessageChannel / MessagePort / Worker, Electron MessagePortMain, and Node
 * worker_threads MessagePort.
 */
import {
  isSandboxWireMessage,
  type SandboxTransport,
  type SandboxWireMessage,
} from './portable-sandbox.ts';

export interface MessagePortLike {
  postMessage(msg: unknown): void;
  addEventListener?(type: 'message', listener: (event: unknown) => void): void;
  on?(event: 'message', listener: (event: unknown) => void): unknown;
  removeEventListener?(type: 'message', listener: (event: unknown) => void): void;
  off?(event: 'message', listener: (event: unknown) => void): unknown;
  removeListener?(event: 'message', listener: (event: unknown) => void): unknown;
  start?(): void;
  close?(): void;
  terminate?(): Promise<unknown> | unknown;
}

function unwrapPortPayload(event: unknown): unknown {
  if (isSandboxWireMessage(event)) return event;
  if (typeof event === 'object' && event !== null && 'data' in event) {
    return (event as { data: unknown }).data;
  }
  return event;
}

/**
 * Wrap a Web MessagePort / Worker, Electron MessagePortMain, or Node worker_threads
 * MessagePort into a portable {@link SandboxTransport}.
 */
export function createMessagePortTransport(port: MessagePortLike): SandboxTransport {
  let closed = false;
  const cleanups = new Set<() => void>();

  return {
    postMessage(msg: SandboxWireMessage): void {
      if (closed) return;
      port.postMessage(msg);
    },

    onMessage(handler: (msg: SandboxWireMessage) => void): () => void {
      if (closed) return () => {};

      const listener = (event: unknown) => {
        if (closed) return;
        const payload = unwrapPortPayload(event);
        if (isSandboxWireMessage(payload)) {
          handler(payload);
        }
      };

      let removed = false;
      let detach: () => void;

      if (typeof port.addEventListener === 'function') {
        port.addEventListener('message', listener);
        port.start?.();
        detach = () => {
          port.removeEventListener?.('message', listener);
        };
      } else if (typeof port.on === 'function') {
        port.on('message', listener);
        port.start?.();
        detach = () => {
          if (typeof port.off === 'function') {
            port.off('message', listener);
          } else {
            port.removeListener?.('message', listener);
          }
        };
      } else {
        throw new TypeError('MessagePortLike must implement addEventListener or on');
      }

      const unsubscribe = () => {
        if (removed) return;
        removed = true;
        cleanups.delete(unsubscribe);
        detach();
      };
      cleanups.add(unsubscribe);
      return unsubscribe;
    },

    async terminate(): Promise<void> {
      if (closed) return;
      closed = true;
      for (const cleanup of [...cleanups]) {
        try {
          cleanup();
        } catch {
          // Ignore listener cleanup errors during termination.
        }
      }
      cleanups.clear();
      if (typeof port.terminate === 'function') {
        await port.terminate();
      } else {
        port.close?.();
      }
    },
  };
}

/**
 * Create a connected in-memory {@link SandboxTransport} pair `[hostTransport, guestTransport]`
 * for fast, deterministic tests and in-process verification.
 *
 * Messages are cloned with `structuredClone` and delivered asynchronously via `queueMicrotask`
 * to match real Worker / MessagePort boundary semantics.
 */
export function createMemoryTransportPair(): [SandboxTransport, SandboxTransport] {
  const handlersA = new Set<(msg: SandboxWireMessage) => void>();
  const handlersB = new Set<(msg: SandboxWireMessage) => void>();
  let closedA = false;
  let closedB = false;

  const makeSide = (
    ownHandlers: Set<(msg: SandboxWireMessage) => void>,
    peerHandlers: Set<(msg: SandboxWireMessage) => void>,
    isOwnClosed: () => boolean,
    isPeerClosed: () => boolean,
    markOwnClosed: () => void,
  ): SandboxTransport => ({
    postMessage(msg: SandboxWireMessage): void {
      if (isOwnClosed() || isPeerClosed()) return;
      const cloned = structuredClone(msg);
      queueMicrotask(() => {
        if (isOwnClosed() || isPeerClosed()) return;
        for (const handler of [...peerHandlers]) {
          handler(cloned);
        }
      });
    },

    onMessage(handler: (msg: SandboxWireMessage) => void): () => void {
      if (isOwnClosed()) return () => {};
      ownHandlers.add(handler);
      return () => {
        ownHandlers.delete(handler);
      };
    },

    terminate(): void {
      if (isOwnClosed()) return;
      markOwnClosed();
      ownHandlers.clear();
    },
  });

  const sideA = makeSide(
    handlersA,
    handlersB,
    () => closedA,
    () => closedB,
    () => { closedA = true; },
  );
  const sideB = makeSide(
    handlersB,
    handlersA,
    () => closedB,
    () => closedA,
    () => { closedB = true; },
  );

  return [sideA, sideB];
}
