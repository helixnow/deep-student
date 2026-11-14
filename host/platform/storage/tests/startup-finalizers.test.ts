import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Context } from '@deepseek-ai/cordis';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { createStorageService, StorageCordisService, type StorageServiceImpl } from '../service.ts';
import { StartupFinalizerError, StorageError } from '../api.ts';
import { setStorageLogger, type StorageLogLevel } from '../logging.ts';
import type { StartupFinalizerRegistration } from '../startup-finalizers.ts';

let base: string;
const services: StorageServiceImpl[] = [];

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-finalizers-'));
});
afterEach(() => {
  setStorageLogger(null);
  for (const service of services.splice(0)) service.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});

function captureLogs(): { target: string; level: StorageLogLevel; message: string }[] {
  const lines: { target: string; level: StorageLogLevel; message: string }[] = [];
  setStorageLogger((target) => {
    const at = (level: StorageLogLevel) => (message: string) => { lines.push({ target, level, message }); };
    return { target, error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'), trace: at('trace') };
  });
  return lines;
}

class TestStorage extends StorageCordisService {
  constructor(ctx: Context) {
    super(ctx, { dataLocalDir: ctx.app.dataDir });
  }
}

interface FinalizerFacade {
  registerFinalizer(name: string, fn: () => void | Promise<void>, options?: StartupFinalizerRegistration): () => void;
  finalizerNames(): readonly string[];
}

function localService(): StorageServiceImpl {
  const service = createStorageService({ baseDir: base, dataLocalDir: base });
  services.push(service);
  return service;
}

describe('startup finalizers (D2)', () => {
  it('runs in dependency order and freezes registration', async () => {
    const service = localService();
    const order: string[] = [];
    service.registerFinalizer('c', () => { order.push('c'); }, { after: ['b'] });
    service.registerFinalizer('a', () => { order.push('a'); });
    service.registerFinalizer('b', async () => { await Promise.resolve(); order.push('b'); }, { after: ['a'] });
    expect(service.finalizerNames()).toEqual(['c', 'a', 'b']);

    const report = await service.runStartupFinalizers();
    expect(order).toEqual(['a', 'b', 'c']);
    expect(report).toEqual({ completed: ['a', 'b', 'c'], skipped: [] });
    expect(() => service.registerFinalizer('late', () => {})).toThrow(expect.objectContaining({ code: 'FINALIZER_LATE_REGISTRATION' }));

    const repeated = await service.runStartupFinalizers();
    expect(repeated.completed).toEqual(['a', 'b', 'c']);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('rejects duplicate names, unknown dependencies and cycles before running any hook', async () => {
    const duplicate = localService();
    duplicate.registerFinalizer('a', () => {});
    expect(() => duplicate.registerFinalizer('a', () => {})).toThrow(expect.objectContaining({ code: 'FINALIZER_DUPLICATE' }));

    const missing = localService();
    let ran = false;
    missing.registerFinalizer('a', () => { ran = true; }, { after: ['missing'] });
    await expect(missing.runStartupFinalizers()).rejects.toMatchObject({ code: 'FINALIZER_UNKNOWN_DEPENDENCY' });
    expect(ran).toBe(false);
    expect(() => missing.registerFinalizer('late', () => { ran = true; }))
      .toThrow(expect.objectContaining({ code: 'FINALIZER_LATE_REGISTRATION' }));
    expect(ran).toBe(false);
  });

  it('reports dependency cycles with both names and does not run partial work', async () => {
    const service = localService();
    const ran: string[] = [];
    service.registerFinalizer('a', () => { ran.push('a'); }, { after: ['b'] });
    service.registerFinalizer('b', () => { ran.push('b'); }, { after: ['a'] });
    await expect(service.runStartupFinalizers()).rejects.toMatchObject({ code: 'FINALIZER_CYCLE' });
    expect(ran).toEqual([]);
  });

  it('keeps the failed name and original error, skips completed hooks on retry', async () => {
    const service = localService();
    const ran: string[] = [];
    let fail = true;
    const original = new Error('restore finalize failed');
    service.registerFinalizer('migrate', () => { ran.push('migrate'); });
    service.registerFinalizer('restore', () => {
      ran.push('restore');
      if (fail) throw original;
    }, { after: ['migrate'] });
    service.registerFinalizer('gate', () => { ran.push('gate'); }, { after: ['restore'] });

    let caught: unknown;
    try { await service.runStartupFinalizers(); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(StartupFinalizerError);
    expect((caught as StartupFinalizerError).finalizer).toBe('restore');
    expect((caught as StartupFinalizerError).cause).toBe(original);
    expect((caught as StartupFinalizerError).completed).toEqual(['migrate']);
    expect(ran).toEqual(['migrate', 'restore']);

    fail = false;
    const report = await service.runStartupFinalizers();
    expect(report.completed).toEqual(['migrate', 'restore', 'gate']);
    expect(report.skipped).toEqual(['migrate']);
    expect(ran).toEqual(['migrate', 'restore', 'restore', 'gate']);
  });

  it('freezes registration after a failed run without executing the rejected callback', async () => {
    const service = localService();
    const ran: string[] = [];
    service.registerFinalizer('fail', () => {
      ran.push('fail');
      throw new Error('finalizer failed');
    });

    await expect(service.runStartupFinalizers()).rejects.toBeInstanceOf(StartupFinalizerError);
    expect(ran).toEqual(['fail']);

    let lateRan = false;
    for (const name of ['late', '', 'fail']) {
      expect(() => service.registerFinalizer(name, () => { lateRan = true; }))
        .toThrow(expect.objectContaining({ code: 'FINALIZER_LATE_REGISTRATION' }));
    }
    expect(lateRan).toBe(false);
    expect(ran).toEqual(['fail']);
  });

  it('rejects empty names and non-function hooks', () => {
    const service = localService();
    expect(() => service.registerFinalizer('', () => {})).toThrow(StorageError);
    expect(() => service.registerFinalizer('x', null as unknown as () => void)).toThrow(StorageError);
  });

  it('V09-P1-3: registerFinalizer hands back the registry disposer and passes late / signal through', async () => {
    const service = localService();
    const ran: string[] = [];
    const dispose = service.registerFinalizer('a', () => { ran.push('stale'); });
    dispose();
    expect(service.finalizerNames()).toEqual([]);
    service.registerFinalizer('a', () => { ran.push('a'); });
    const controller = new AbortController();
    service.registerFinalizer('b', () => { ran.push('b'); }, { signal: controller.signal });
    controller.abort();
    expect(service.finalizerNames()).toEqual(['a']);

    expect(await service.runStartupFinalizers()).toEqual({ completed: ['a'], skipped: [] });
    expect(ran).toEqual(['a']);
    expect(() => service.registerFinalizer('a', () => { ran.push('skipped'); }, { late: 'skip' })).not.toThrow();
    service.registerFinalizer('a', () => { ran.push('again'); }, { late: 'run' });
    expect(ran).toEqual(['a', 'again']);
  });

  it('V09-P1-3: a late-run hook that rejects is logged on dstu_storage::lifecycle instead of escaping as an unhandled rejection', async () => {
    const lines = captureLogs();
    const service = localService();
    await service.runStartupFinalizers();
    service.registerFinalizer('late.async', async () => { throw new Error('sweep failed'); }, { late: 'run' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(lines).toEqual([
      { target: 'dstu_storage::lifecycle', level: 'error', message: '启动收尾钩子 late.async 晚注册执行失败: sweep failed' },
    ]);
  });

  it('V09-P1-3: ctx.storage.registerFinalizer returns the disposer to plugins', async () => {
    const host = await createTestHost({ provide: { storage: TestStorage } });
    try {
      const storage = host.ctx.get('storage') as unknown as FinalizerFacade;
      const dispose = storage.registerFinalizer('plugin.startup', () => {});
      expect(storage.finalizerNames()).toEqual(['plugin.startup']);
      expect(typeof dispose).toBe('function');
      dispose();
      expect(storage.finalizerNames()).toEqual([]);
    } finally {
      await host.dispose();
    }
  });
});
