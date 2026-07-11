import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

// Node 26 exposes a configurable global `localStorage` getter that returns
// undefined unless `--localstorage-file` is set. That getter can shadow the
// JSDOM storage installed on `window`, so bind tests to the browser-like store.
if (typeof window !== 'undefined') {
  const values = new Map<string, string>();
  const browserStorage: Storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(String(key)) ?? null,
    key: (index: number) => Array.from(values.keys())[index] ?? null,
    removeItem: (key: string) => {
      values.delete(String(key));
    },
    setItem: (key: string, value: string) => {
      values.set(String(key), String(value));
    },
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    enumerable: true,
    value: browserStorage,
  });
}

// Force i18n language for deterministic snapshot/labels in tests.
try {
  localStorage.setItem('i18nextLng', 'zh-CN');
} catch {
  // ignore
}

// 确保每个用例后清理 DOM，避免跨用例 DOM 污染导致的“multiple elements found”不稳定
afterEach(() => {
  cleanup();
});

// Mock SubjectContext used by components to avoid hitting real Tauri in tests
vi.mock('/src/contexts/SubjectContext.tsx', () => {
  const ctx = {
    currentSubject: '数学',
    setCurrentSubject: () => {},
    availableSubjects: ['数学'],
    subjectConfigs: [],
    loading: false,
    error: null,
    refreshSubjects: async () => {},
    getEnabledSubjects: () => ['数学'],
    getAllSubjects: () => ['数学'],
  };
  return {
    SubjectProvider: ({ children }: any) => children,
    useSubject: () => ctx,
  } as any;
});

// Minimal ResizeObserver shim for JSDOM
class RO {
  observe() {}
  unobserve() {}
  disconnect() {}
}
// @ts-ignore
global.ResizeObserver = (global as any).ResizeObserver || RO;

if (typeof window !== 'undefined') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

if (typeof Element !== 'undefined') {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = () => {};
  }
  if (!Element.prototype.hasPointerCapture) {
    Element.prototype.hasPointerCapture = () => false;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = () => {};
  }
}
