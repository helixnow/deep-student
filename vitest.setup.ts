import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';

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

