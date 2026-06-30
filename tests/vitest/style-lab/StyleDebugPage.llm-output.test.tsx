import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { StyleDebugPage } from '@/components/style-lab/StyleDebugPage';

function createMatchMedia(matches = false): typeof window.matchMedia {
  return ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })) as typeof window.matchMedia;
}

function createStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

describe('StyleDebugPage LLM output lab', () => {
  const originalMatchMedia = window.matchMedia;
  const originalLocalStorage = globalThis.localStorage;

  beforeAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: createMatchMedia(false),
    });
  });

  beforeEach(() => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
    });
  });

  afterAll(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: originalMatchMedia,
    });
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders the current migration overview instead of the removed LLM playback lab', async () => {
    render(<StyleDebugPage />);

    expect(screen.getByRole('button', { name: '迁移概览' })).toHaveAttribute('data-state', 'active');
    expect(screen.getByText('总体迁移率')).toBeInTheDocument();
    expect(screen.getByText('组件族迁移进度')).toBeInTheDocument();
    expect(document.querySelector('.llm-output-playback')).toBeNull();
    expect(document.querySelector('.llm-output-grid')).toBeNull();
    expect(screen.queryByText('发送中')).toBeNull();
  });

  it('surfaces mixed usage groups from the current scan data', async () => {
    render(<StyleDebugPage />);
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: '混用清单' }));

    expect(screen.getByText('Button')).toBeInTheDocument();
    expect(screen.getByText('Form Controls')).toBeInTheDocument();
    expect(screen.getByText('Dialog / Overlay')).toBeInTheDocument();
    expect(screen.getByText('Scroll')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '开始回放' })).not.toBeInTheDocument();
  });
});
