/**
 * Portable Sandbox Runtime Foundation (W06 Alternative B).
 *
 * Host <-> isolated `restricted` plugin capability broker and JSON-RPC 2.0 wire protocol.
 * 100% Node-free so it runs identically across Desktop Chromium hidden renderer IPC,
 * WebUI Web Workers, iframe MessagePorts, and Mobile runtimes.
 */
import { grantedServices, type PluginManifest } from '../manifest.ts';

export type SandboxErrorCode =
  | 'PERMISSION_DENIED'
  | 'METHOD_NOT_FOUND'
  | 'INVALID_REQUEST'
  | 'SANDBOX_TIMEOUT'
  | 'SANDBOX_OVERLOADED'
  | 'SANDBOX_DISPOSED'
  | 'INTERNAL_ERROR';

export interface SandboxRpcError {
  readonly code: SandboxErrorCode;
  readonly message: string;
  readonly data?: unknown;
}

export interface SandboxCallRequest {
  readonly jsonrpc: '2.0';
  readonly kind: 'call';
  readonly id: string;
  readonly target: 'host' | 'plugin';
  readonly service?: string;
  readonly method: string;
  readonly args: readonly unknown[];
}

export type SandboxCallResponse =
  | {
      readonly jsonrpc: '2.0';
      readonly kind: 'result';
      readonly id: string;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly jsonrpc: '2.0';
      readonly kind: 'result';
      readonly id: string;
      readonly ok: false;
      readonly error: SandboxRpcError;
    };

export type SandboxWireMessage = SandboxCallRequest | SandboxCallResponse;

export interface SandboxTransport {
  postMessage(msg: SandboxWireMessage): void;
  onMessage(handler: (msg: SandboxWireMessage) => void): () => void;
  terminate(): Promise<void> | void;
}

export class SandboxError extends Error {
  readonly code: SandboxErrorCode;
  readonly data?: unknown;

  constructor(code: SandboxErrorCode, message: string, data?: unknown) {
    const prefixed = message.startsWith(`${code}:`) ? message : `${code}: ${message}`;
    super(prefixed);
    this.name = 'SandboxError';
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

export interface SandboxHostBrokerOptions {
  pluginId: string;
  manifest: Pick<PluginManifest, 'id' | 'permissions'>;
  transport: SandboxTransport;
  services: Readonly<Record<string, unknown>>;
  defaultTimeoutMs?: number;
  maxConcurrentCalls?: number;
}

export interface SandboxGuestBridgeOptions {
  defaultTimeoutMs?: number;
}

export interface SandboxGuestBridge {
  callHost<T = unknown>(service: string, method: string, ...args: unknown[]): Promise<T>;
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_CONCURRENT_CALLS = 32;

const BLOCKED_PATH_SEGMENTS: ReadonlySet<string> = new Set([
  '__proto__',
  'constructor',
  'prototype',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
]);

const VALID_ERROR_CODES: ReadonlySet<string> = new Set<SandboxErrorCode>([
  'PERMISSION_DENIED',
  'METHOD_NOT_FOUND',
  'INVALID_REQUEST',
  'SANDBOX_TIMEOUT',
  'SANDBOX_OVERLOADED',
  'SANDBOX_DISPOSED',
  'INTERNAL_ERROR',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural guard for SandboxWireMessage frames crossing a transport boundary. */
export function isSandboxWireMessage(value: unknown): value is SandboxWireMessage {
  if (!isRecord(value) || value.jsonrpc !== '2.0' || typeof value.id !== 'string' || !value.id) {
    return false;
  }
  if (value.kind === 'call') {
    return (
      (value.target === 'host' || value.target === 'plugin')
      && typeof value.method === 'string'
      && Array.isArray(value.args)
      && (value.service === undefined || typeof value.service === 'string')
    );
  }
  if (value.kind === 'result') {
    if (value.ok === true) return true;
    if (value.ok === false && isRecord(value.error)) {
      return typeof value.error.code === 'string' && typeof value.error.message === 'string';
    }
  }
  return false;
}

function normalizeErrorCode(code: unknown): SandboxErrorCode {
  return typeof code === 'string' && VALID_ERROR_CODES.has(code)
    ? (code as SandboxErrorCode)
    : 'INTERNAL_ERROR';
}

function parseMethodPath(path: string): string[] {
  if (typeof path !== 'string' || path.length === 0) {
    throw new SandboxError('INVALID_REQUEST', 'method path must be a non-empty string');
  }
  const segments = path.split('.');
  for (const seg of segments) {
    if (BLOCKED_PATH_SEGMENTS.has(seg)) {
      throw new SandboxError('PERMISSION_DENIED', `access to blocked property "${seg}" is denied`);
    }
  }
  for (const seg of segments) {
    if (seg.length === 0) {
      throw new SandboxError('INVALID_REQUEST', `invalid method path "${path}"`);
    }
  }
  return segments;
}

function inspectSafeProperty(obj: object, key: string): 'ok' | 'proto-blocked' | 'missing' {
  if (BLOCKED_PATH_SEGMENTS.has(key)) return 'proto-blocked';
  if (Object.hasOwn(obj, key)) return 'ok';
  let proto: object | null = Object.getPrototypeOf(obj);
  while (proto !== null && proto !== Object.prototype && proto !== Function.prototype) {
    if (Object.hasOwn(proto, key)) return 'ok';
    proto = Object.getPrototypeOf(proto);
  }
  if (proto !== null && Object.hasOwn(proto, key)) return 'proto-blocked';
  return 'missing';
}

function resolveDotPathCallable(
  root: unknown,
  path: string,
  label: string,
): { fn: (...args: unknown[]) => unknown; receiver: unknown } {
  const segments = parseMethodPath(path);
  let current: unknown = root;
  let parent: unknown = undefined;

  for (const segment of segments) {
    if (current === null || (typeof current !== 'object' && typeof current !== 'function')) {
      throw new SandboxError('METHOD_NOT_FOUND', `"${label}.${path}" could not be resolved`);
    }
    const status = inspectSafeProperty(current as object, segment);
    if (status === 'proto-blocked') {
      throw new SandboxError('PERMISSION_DENIED', `access to prototype property "${segment}" on "${label}" is denied`);
    }
    if (status === 'missing') {
      throw new SandboxError('METHOD_NOT_FOUND', `"${label}.${path}" was not found`);
    }
    parent = current;
    current = (current as Record<string, unknown>)[segment];
  }

  if (typeof current !== 'function') {
    throw new SandboxError('METHOD_NOT_FOUND', `"${label}.${path}" is not callable`);
  }
  return { fn: current as (...args: unknown[]) => unknown, receiver: parent };
}

function toRpcError(error: unknown): SandboxRpcError {
  if (error instanceof SandboxError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.data !== undefined ? { data: error.data } : {}),
    };
  }
  const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
  return { code: 'INTERNAL_ERROR', message };
}

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (reason: SandboxError) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Host-side capability broker for an isolated `restricted` plugin runtime.
 *
 * Enforces strict manifest-based service allowlisting, prototype-pollution protection,
 * bounded concurrency, per-call timeouts, and deterministic disposal.
 */
export class SandboxHostBroker {
  readonly pluginId: string;
  readonly allowedServices: ReadonlySet<string>;

  private readonly transport: SandboxTransport;
  private readonly services: Readonly<Record<string, unknown>>;
  private readonly defaultTimeoutMs: number;
  private readonly maxConcurrentCalls: number;
  private readonly pendingCalls = new Map<string, PendingCall>();
  private readonly unsubscribe: () => void;

  private nextCallId = 0;
  private inFlightGuestCalls = 0;
  private isDisposed = false;
  private disposePromise: Promise<void> | null = null;

  constructor(options: SandboxHostBrokerOptions) {
    this.pluginId = options.pluginId;
    this.transport = options.transport;
    this.services = options.services;

    const timeout = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(timeout) || timeout <= 0) {
      throw new SandboxError('INVALID_REQUEST', 'defaultTimeoutMs must be a positive finite number');
    }
    this.defaultTimeoutMs = timeout;

    const maxConcurrent = options.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS;
    if (!Number.isInteger(maxConcurrent) || maxConcurrent <= 0) {
      throw new SandboxError('INVALID_REQUEST', 'maxConcurrentCalls must be a positive integer');
    }
    this.maxConcurrentCalls = maxConcurrent;

    const granted = grantedServices(options.manifest);
    const filtered = new Set<string>();
    for (const serviceName of granted) {
      if (serviceName && !serviceName.includes('.') && !BLOCKED_PATH_SEGMENTS.has(serviceName)) {
        filtered.add(serviceName);
      }
    }
    this.allowedServices = filtered;

    this.unsubscribe = this.transport.onMessage((msg) => {
      this.handleMessage(msg);
    });
  }

  get disposed(): boolean {
    return this.isDisposed;
  }

  /** Invoke an exported handler inside the isolated plugin runtime. */
  callPlugin<T = unknown>(
    method: string,
    args: readonly unknown[] = [],
    timeoutMs?: number,
  ): Promise<T> {
    if (this.isDisposed) {
      return Promise.reject(
        new SandboxError('SANDBOX_DISPOSED', `sandbox for plugin "${this.pluginId}" is disposed`),
      );
    }

    try {
      parseMethodPath(method);
    } catch (error) {
      return Promise.reject(error);
    }

    if (this.pendingCalls.size >= this.maxConcurrentCalls) {
      return Promise.reject(
        new SandboxError(
          'SANDBOX_OVERLOADED',
          `plugin "${this.pluginId}" exceeded max concurrent calls (${this.maxConcurrentCalls})`,
        ),
      );
    }

    const effectiveTimeout = timeoutMs ?? this.defaultTimeoutMs;
    if (!Number.isFinite(effectiveTimeout) || effectiveTimeout <= 0) {
      return Promise.reject(
        new SandboxError('INVALID_REQUEST', 'timeoutMs must be a positive finite number'),
      );
    }

    const id = `h2p-${++this.nextCallId}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pendingCalls.delete(id)) return;
        reject(
          new SandboxError(
            'SANDBOX_TIMEOUT',
            `plugin "${this.pluginId}" call "${method}" timed out after ${effectiveTimeout}ms`,
          ),
        );
      }, effectiveTimeout);

      this.pendingCalls.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });

      try {
        this.transport.postMessage({
          jsonrpc: '2.0',
          kind: 'call',
          id,
          target: 'plugin',
          method,
          args: [...args],
        });
      } catch (error) {
        this.pendingCalls.delete(id);
        clearTimeout(timer);
        reject(
          error instanceof SandboxError
            ? error
            : new SandboxError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error)),
        );
      }
    });
  }

  /** Reject all pending calls with SANDBOX_DISPOSED and terminate the underlying transport. */
  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.isDisposed = true;
    this.disposePromise = (async () => {
      try {
        this.unsubscribe();
      } catch {
        // Ignore unsubscribe errors during teardown.
      }
      const disposedError = new SandboxError(
        'SANDBOX_DISPOSED',
        `sandbox for plugin "${this.pluginId}" was disposed`,
      );
      for (const pending of this.pendingCalls.values()) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.reject(disposedError);
      }
      this.pendingCalls.clear();
      await this.transport.terminate();
    })();
    return this.disposePromise;
  }

  private handleMessage(msg: SandboxWireMessage): void {
    if (this.isDisposed || !isSandboxWireMessage(msg)) return;

    if (msg.kind === 'result') {
      const pending = this.pendingCalls.get(msg.id);
      if (!pending) return;
      this.pendingCalls.delete(msg.id);
      if (pending.timer !== null) clearTimeout(pending.timer);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(
          new SandboxError(
            normalizeErrorCode(msg.error.code),
            msg.error.message,
            msg.error.data,
          ),
        );
      }
      return;
    }

    if (msg.target === 'host') {
      void this.handleGuestCall(msg);
    }
  }

  private async handleGuestCall(msg: SandboxCallRequest): Promise<void> {
    if (this.inFlightGuestCalls >= this.maxConcurrentCalls) {
      this.sendError(
        msg.id,
        new SandboxError(
          'SANDBOX_OVERLOADED',
          `host broker for plugin "${this.pluginId}" exceeded max concurrent calls (${this.maxConcurrentCalls})`,
        ),
      );
      return;
    }

    this.inFlightGuestCalls++;
    try {
      const serviceName = msg.service;
      if (typeof serviceName !== 'string' || serviceName.length === 0) {
        throw new SandboxError('PERMISSION_DENIED', 'service name is required');
      }
      for (const seg of serviceName.split('.')) {
        if (BLOCKED_PATH_SEGMENTS.has(seg)) {
          throw new SandboxError('PERMISSION_DENIED', `access to blocked service "${serviceName}" is denied`);
        }
      }
      if (serviceName.includes('.') || !this.allowedServices.has(serviceName)) {
        throw new SandboxError(
          'PERMISSION_DENIED',
          `plugin "${this.pluginId}" is not permitted to access service "${serviceName}"`,
        );
      }
      if (!Object.hasOwn(this.services, serviceName)) {
        throw new SandboxError('PERMISSION_DENIED', `service "${serviceName}" is not exposed to plugin "${this.pluginId}"`);
      }

      const serviceObj = this.services[serviceName];
      const { fn, receiver } = resolveDotPathCallable(serviceObj, msg.method, serviceName);
      const result = await fn.apply(receiver, [...msg.args]);
      if (!this.isDisposed) {
        this.transport.postMessage({
          jsonrpc: '2.0',
          kind: 'result',
          id: msg.id,
          ok: true,
          result,
        });
      }
    } catch (error) {
      if (!this.isDisposed) {
        this.sendError(msg.id, error);
      }
    } finally {
      this.inFlightGuestCalls--;
    }
  }

  private sendError(id: string, error: unknown): void {
    if (this.isDisposed) return;
    try {
      this.transport.postMessage({
        jsonrpc: '2.0',
        kind: 'result',
        id,
        ok: false,
        error: toRpcError(error),
      });
    } catch {
      // Transport may already be closed during teardown.
    }
  }
}

/**
 * Guest-side counterpart running inside a Worker, hidden renderer, or iframe.
 * Exposes `callHost(service, method, ...args)` and dispatches incoming host calls to `handlers`.
 */
export function createSandboxGuestBridge(
  transport: SandboxTransport,
  handlers: Record<string, (...args: unknown[]) => unknown>,
  options: SandboxGuestBridgeOptions = {},
): SandboxGuestBridge {
  const pendingHostCalls = new Map<string, PendingCall>();
  const defaultTimeoutMs = options.defaultTimeoutMs;
  let nextCallId = 0;
  let disposed = false;

  const sendError = (id: string, error: unknown): void => {
    if (disposed) return;
    try {
      transport.postMessage({
        jsonrpc: '2.0',
        kind: 'result',
        id,
        ok: false,
        error: toRpcError(error),
      });
    } catch {
      // Transport closed.
    }
  };

  const unsubscribe = transport.onMessage((msg) => {
    if (disposed || !isSandboxWireMessage(msg)) return;

    if (msg.kind === 'result') {
      const pending = pendingHostCalls.get(msg.id);
      if (!pending) return;
      pendingHostCalls.delete(msg.id);
      if (pending.timer !== null) clearTimeout(pending.timer);
      if (msg.ok) {
        pending.resolve(msg.result);
      } else {
        pending.reject(
          new SandboxError(
            normalizeErrorCode(msg.error.code),
            msg.error.message,
            msg.error.data,
          ),
        );
      }
      return;
    }

    if (msg.target === 'plugin') {
      void (async () => {
        try {
          let fn: (...args: unknown[]) => unknown;
          let receiver: unknown = handlers;
          if (!BLOCKED_PATH_SEGMENTS.has(msg.method) && Object.hasOwn(handlers, msg.method) && typeof handlers[msg.method] === 'function') {
            fn = handlers[msg.method]!;
          } else {
            const resolved = resolveDotPathCallable(handlers, msg.method, 'plugin');
            fn = resolved.fn;
            receiver = resolved.receiver;
          }
          const result = await fn.apply(receiver, [...msg.args]);
          if (!disposed) {
            transport.postMessage({
              jsonrpc: '2.0',
              kind: 'result',
              id: msg.id,
              ok: true,
              result,
            });
          }
        } catch (error) {
          sendError(msg.id, error);
        }
      })();
    }
  });

  return {
    callHost<T = unknown>(service: string, method: string, ...args: unknown[]): Promise<T> {
      if (disposed) {
        return Promise.reject(new SandboxError('SANDBOX_DISPOSED', 'guest bridge is disposed'));
      }
      const id = `p2h-${++nextCallId}`;
      return new Promise<T>((resolve, reject) => {
        const timer = defaultTimeoutMs !== undefined && Number.isFinite(defaultTimeoutMs) && defaultTimeoutMs > 0
          ? setTimeout(() => {
              if (!pendingHostCalls.delete(id)) return;
              reject(new SandboxError('SANDBOX_TIMEOUT', `host call "${service}.${method}" timed out after ${defaultTimeoutMs}ms`));
            }, defaultTimeoutMs)
          : null;

        pendingHostCalls.set(id, {
          resolve: resolve as (value: unknown) => void,
          reject,
          timer,
        });

        try {
          transport.postMessage({
            jsonrpc: '2.0',
            kind: 'call',
            id,
            target: 'host',
            service,
            method,
            args,
          });
        } catch (error) {
          pendingHostCalls.delete(id);
          if (timer !== null) clearTimeout(timer);
          reject(
            error instanceof SandboxError
              ? error
              : new SandboxError('INTERNAL_ERROR', error instanceof Error ? error.message : String(error)),
          );
        }
      });
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      try {
        unsubscribe();
      } catch {
        // Ignore teardown errors.
      }
      const err = new SandboxError('SANDBOX_DISPOSED', 'guest bridge was disposed');
      for (const pending of pendingHostCalls.values()) {
        if (pending.timer !== null) clearTimeout(pending.timer);
        pending.reject(err);
      }
      pendingHostCalls.clear();
    },
  };
}
