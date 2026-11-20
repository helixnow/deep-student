/**
 * V06-L3：启动时申请持久存储（OPFS 默认 best-effort）。已持久时不再申请；被拒、不支持、调用失败都记录原因且不抛错。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PERSISTENT_STORAGE_STATUS_EVENT,
  PERSISTENT_STORAGE_WARNING_DISMISSED_KEY,
  mountPersistentStorageWarningBanner,
  reportPersistentStorageStatus,
  requestPersistentStorage,
  toPersistentStorageStatus,
  type PersistentStorageStatus,
} from '../../src/shell/persistent-storage.ts';

interface FakeElement {
  tagName: string;
  id: string;
  type: string;
  textContent: string | null;
  style: { cssText: string };
  children: FakeElement[];
  parentElement: FakeElement | null;
  attributes: Map<string, string>;
  listeners: Map<string, Array<() => void>>;
  setAttribute(name: string, value: string): void;
  getAttribute(name: string): string | null;
  appendChild(child: FakeElement): FakeElement;
  addEventListener(type: string, cb: () => void): void;
  remove(): void;
  click(): void;
}

function createFakeElement(tagName: string): FakeElement {
  const el: FakeElement = {
    tagName: tagName.toUpperCase(),
    id: '',
    type: '',
    textContent: null,
    style: { cssText: '' },
    children: [],
    parentElement: null,
    attributes: new Map(),
    listeners: new Map(),
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    },
    getAttribute(name: string) {
      return this.attributes.get(name) ?? null;
    },
    appendChild(child: FakeElement) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    addEventListener(type: string, cb: () => void) {
      const list = this.listeners.get(type) ?? [];
      list.push(cb);
      this.listeners.set(type, list);
    },
    remove() {
      if (!this.parentElement) return;
      this.parentElement.children = this.parentElement.children.filter(item => item !== this);
      this.parentElement = null;
    },
    click() {
      for (const cb of this.listeners.get('click') ?? []) cb();
    },
  };
  return el;
}

function createFakeDom(lang = 'zh-CN') {
  const body = createFakeElement('body');
  const findById = (root: FakeElement, id: string): FakeElement | null => {
    if (root.id === id) return root;
    for (const child of root.children) {
      const hit = findById(child, id);
      if (hit) return hit;
    }
    return null;
  };
  const doc = {
    documentElement: { lang },
    body,
    createElement: (tag: string) => createFakeElement(tag),
    getElementById: (id: string) => findById(body, id),
  } as unknown as Document;

  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };

  return { doc, body, storage, store };
}

afterEach(() => {
  delete globalThis.__DEEP_STUDENT_PERSISTENT_STORAGE_STATUS__;
  vi.unstubAllGlobals();
});

describe('requestPersistentStorage', () => {
  it('asks for persistence when not yet persisted and reports a refusal', async () => {
    const logs: string[] = [];
    const persist = vi.fn(async () => false);
    await expect(requestPersistentStorage({ persisted: async () => false, persist }, m => logs.push(m))).resolves.toBe(false);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(logs).toEqual(['[storage] persistent storage was not granted; OPFS data may be evicted under storage pressure']);
  });

  it('does not ask again when the origin is already persisted', async () => {
    const persist = vi.fn(async () => true);
    await expect(requestPersistentStorage({ persisted: async () => true, persist }, () => undefined)).resolves.toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it('grants silently', async () => {
    const logs: string[] = [];
    await expect(requestPersistentStorage({ persisted: async () => false, persist: async () => true }, m => logs.push(m))).resolves.toBe(true);
    expect(logs).toEqual([]);
  });

  it('missing API or a failing call is logged, never thrown', async () => {
    const logs: string[] = [];
    await expect(requestPersistentStorage(undefined, m => logs.push(m))).resolves.toBeNull();
    await expect(requestPersistentStorage({ persist: async () => { throw new Error('SecurityError'); } }, m => logs.push(m))).resolves.toBeNull();
    expect(logs).toEqual([
      '[storage] navigator.storage.persist() is unavailable; OPFS data may be evicted under storage pressure',
      '[storage] persistent storage request failed: SecurityError',
    ]);
  });
});

describe('persistent storage status & warning banner', () => {
  it('maps boolean | null results into PersistentStorageStatus', () => {
    expect(toPersistentStorageStatus(true)).toBe('granted');
    expect(toPersistentStorageStatus(false)).toBe('denied');
    expect(toPersistentStorageStatus(null)).toBe('unavailable');
  });

  it('reports status to globalThis and dispatches CustomEvent safely across environments', () => {
    const dispatched: Array<{ type: string; status: PersistentStorageStatus }> = [];
    const target = {
      __DEEP_STUDENT_PERSISTENT_STORAGE_STATUS__: undefined as PersistentStorageStatus | undefined,
      dispatchEvent: vi.fn((event: Event) => {
        dispatched.push({
          type: event.type,
          status: (event as CustomEvent<{ status: PersistentStorageStatus }>).detail.status,
        });
        return true;
      }),
    };

    expect(reportPersistentStorageStatus(false, target)).toBe('denied');
    expect(target.__DEEP_STUDENT_PERSISTENT_STORAGE_STATUS__).toBe('denied');
    expect(dispatched).toEqual([{ type: PERSISTENT_STORAGE_STATUS_EVENT, status: 'denied' }]);

    // Also works on globalThis and when CustomEvent is absent in restricted Node runtimes
    vi.stubGlobal('CustomEvent', undefined);
    expect(reportPersistentStorageStatus(true)).toBe('granted');
    expect(globalThis.__DEEP_STUDENT_PERSISTENT_STORAGE_STATUS__).toBe('granted');
  });

  it('returns null safely in Node when document is unavailable', () => {
    expect(mountPersistentStorageWarningBanner()).toBeNull();
  });

  it('mounts Chinese warning banner with safe-area padding, 44px close button, and persists dismissal', () => {
    const { doc, body, storage, store } = createFakeDom('zh-CN');
    const banner = mountPersistentStorageWarningBanner({ document: doc, storage }) as unknown as FakeElement | null;
    expect(banner).not.toBeNull();
    expect(body.children).toHaveLength(1);
    expect(banner?.style.cssText).toContain('--android-safe-area-top');
    expect(banner?.style.cssText).toContain('env(safe-area-inset-top, 0px)');

    const textSpan = banner?.children[0];
    const closeBtn = banner?.children[1];
    expect(textSpan?.textContent).toContain('系统未授予持久化存储权限，清理空间时本地学习数据可能被回收，建议开启云端同步或定期备份');
    expect(closeBtn?.style.cssText).toContain('min-width: 44px');
    expect(closeBtn?.style.cssText).toContain('min-height: 44px');

    // Idempotent when already mounted
    expect(mountPersistentStorageWarningBanner({ document: doc, storage })).toBe(banner);
    expect(body.children).toHaveLength(1);

    // Dismissing removes the banner and writes permanent flag to storage
    closeBtn?.click();
    expect(body.children).toHaveLength(0);
    expect(store.get(PERSISTENT_STORAGE_WARNING_DISMISSED_KEY)).toBe('1');
    expect(mountPersistentStorageWarningBanner({ document: doc, storage })).toBeNull();
  });

  it('adapts banner copy to English via documentElement.lang or navigator.language', () => {
    const { doc, storage } = createFakeDom('');
    vi.stubGlobal('navigator', { language: 'en-US' });
    const banner = mountPersistentStorageWarningBanner({ document: doc, storage }) as unknown as FakeElement | null;
    expect(banner?.children[0]?.textContent).toMatch(/Persistent storage/i);
    expect(banner?.children[1]?.getAttribute('aria-label')).toMatch(/Dismiss/i);
  });
});
