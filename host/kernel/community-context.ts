/** K1 context narrowing, not a same-process sandbox. Never hand community code the raw Cordis context. */
import type { Context } from '@deepseek-ai/cordis';
import { assertKernelSurface, type KernelState } from './kernel.ts';
import { PluginLoadError } from './plugin-load-error.ts';

const INTERNALS = new Set(['root', 'registry', 'fiber', 'runtime', 'scope', 'parent', 'ctx', 'store', 'props', '_getImpl', '_kernel', 'plugin', 'inject']);

export function communityContext(context: Context, kernel: KernelState, id: string): Context {
  const execute = <T>(callback: () => T): T => kernel.execution ? kernel.execution.run(context.fiber, callback) : callback();
  const callback = (fn: (...args: any[]) => any) => function (this: unknown, ...args: any[]) {
    const result = execute(() => fn.apply(this, args));
    return typeof result === 'function' ? callback(result) : result;
  };
  const argumentsWithOwner = (args: unknown[]) => args.map(arg => typeof arg === 'function' ? callback(arg as (...args: any[]) => any) : arg);
  const deny = (path: string): never => {
    // RUST-FIX(RF-P1-managed-plugin-install): Reuse K1 owner checks for context/registry traversal, including full trust.
    assertKernelSurface(kernel, context.fiber, path);
    throw new PluginLoadError('KERNEL_API_FORBIDDEN', id, `${path} is not available to community plugins in plugin API v1`);
  };
  const check = (key: PropertyKey, path: string) => {
    if (typeof key === 'symbol' || String(key).startsWith('_') || INTERNALS.has(String(key))) deny(path);
  };
  const services = new WeakMap<object, object>();
  const service = (value: any, path: string): any => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return value;
    const cached = services.get(value);
    if (cached) return cached;
    const proxy = new Proxy(typeof value === 'function' ? function () {} : Object.create(null), {
      get(_target, key) {
        if (key === Symbol.iterator) return value[key]?.bind(value);
        check(key, `${path}.${String(key)}`);
        const member = Reflect.get(value, key, value);
        return typeof member === 'function' ? (...args: unknown[]) => {
          if (path === 'ctx.events' && typeof args[0] === 'string' && args[0].startsWith('internal/')) deny(`${path}.${String(key)}(${JSON.stringify(args[0])})`);
          return execute(() => member.apply(value, argumentsWithOwner(args)));
        } : service(member, `${path}.${String(key)}`);
      },
      apply(_target, _receiver, args) { return execute(() => value(...argumentsWithOwner(args))); },
      set() { return false; },
    });
    services.set(value, proxy);
    return proxy;
  };
  const lookup = (name: string, strict?: boolean) => {
    check(name, `ctx.get(${JSON.stringify(name)})`);
    return service(context.get(name, strict), `ctx.${name}`);
  };
  const reflect = new Proxy(Object.create(null), {
    get(_target, key) { if (key === 'get') return lookup; return deny(`ctx.reflect.${String(key)}`); },
    set() { return false; },
  });
  return new Proxy(Object.create(null), {
    get(_target, key) {
      check(key, `ctx.${String(key)}`);
      if (key === 'get') return lookup;
      if (key === 'reflect') return reflect;
      if (key === 'provide') return (name: string, value: any) => {
        const owned = value && typeof value === 'object' ? new Proxy(value, {
          get(target, prop, receiver) {
            const member = Reflect.get(target, prop, receiver);
            return typeof member === 'function' ? callback(member.bind(target)) : member;
          },
        }) : typeof value === 'function' ? callback(value) : value;
        return context.provide(name, owned);
      };
      if (key === 'extend' || key === 'isolate' || key === 'intercept') {
        return (...args: unknown[]) => communityContext((context[key] as (...args: unknown[]) => Context).apply(context, args), kernel, id);
      }
      const member = Reflect.get(context, key, context);
      if (key === 'on' || key === 'once' || key === 'emit' || key === 'parallel' || key === 'serial' || key === 'waterfall' || key === 'bail') {
        return (event: string, ...args: unknown[]) => {
          if (typeof event === 'string' && event.startsWith('internal/')) deny(`ctx.${String(key)}(${JSON.stringify(event)})`);
          return execute(() => member.call(context, event, ...argumentsWithOwner(args)));
        };
      }
      return typeof member === 'function' ? (...args: unknown[]) => execute(() => member.apply(context, argumentsWithOwner(args))) : service(member, `ctx.${String(key)}`);
    },
    set() { return false; },
  }) as Context;
}
