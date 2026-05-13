import { beforeEach, describe, expect, it, vi } from 'vitest';

function createStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map<string, string>(Object.entries(initial));
  return {
    get length() {
      return data.size;
    },
    clear() {
      data.clear();
    },
    getItem(key: string) {
      return data.has(key) ? data.get(key)! : null;
    },
    key(index: number) {
      return Array.from(data.keys())[index] ?? null;
    },
    removeItem(key: string) {
      data.delete(key);
    },
    setItem(key: string, value: string) {
      data.set(key, value);
    },
  };
}

describe('skillDefaults bootstrap', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('adds deep-student for first-time users', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage(),
      configurable: true,
      writable: true,
    });

    const { skillDefaults } = await import('../skillDefaults');

    expect(skillDefaults.getAll()).toContain('deep-student');
    expect(globalThis.localStorage.getItem('dstu-skill-defaults:migrate-deep-student-v1')).toBe('1');
  });

  it('migrates existing users once if key missing', async () => {
    const existing = JSON.stringify(['tutor-mode']);
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage({
        'dstu-skill-defaults': existing,
      }),
      configurable: true,
      writable: true,
    });

    const { skillDefaults } = await import('../skillDefaults');

    expect(skillDefaults.getAll()).toContain('tutor-mode');
    expect(skillDefaults.getAll()).toContain('deep-student');
    expect(globalThis.localStorage.getItem('dstu-skill-defaults:migrate-deep-student-v1')).toBe('1');
  });

  it('does not force re-add after user removed and migration completed', async () => {
    const existing = JSON.stringify(['tutor-mode']);
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage({
        'dstu-skill-defaults': existing,
        'dstu-skill-defaults:migrate-deep-student-v1': '1',
      }),
      configurable: true,
      writable: true,
    });

    const { skillDefaults } = await import('../skillDefaults');

    expect(skillDefaults.getAll()).toContain('tutor-mode');
    expect(skillDefaults.getAll()).not.toContain('deep-student');
  });

  it('migrates legacy dstu-memory-orchestrator defaults to deep-student', async () => {
    const existing = JSON.stringify(['tutor-mode', 'dstu-memory-orchestrator']);
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage({
        'dstu-skill-defaults': existing,
      }),
      configurable: true,
      writable: true,
    });

    const { skillDefaults } = await import('../skillDefaults');

    expect(skillDefaults.getAll()).toContain('tutor-mode');
    expect(skillDefaults.getAll()).toContain('deep-student');
    expect(skillDefaults.getAll()).not.toContain('dstu-memory-orchestrator');
  });

  it('migrates legacy deep-scholar defaults to deep-student', async () => {
    const existing = JSON.stringify(['tutor-mode', 'deep-scholar']);
    Object.defineProperty(globalThis, 'localStorage', {
      value: createStorage({
        'dstu-skill-defaults': existing,
      }),
      configurable: true,
      writable: true,
    });

    const { skillDefaults } = await import('../skillDefaults');

    expect(skillDefaults.getAll()).toContain('tutor-mode');
    expect(skillDefaults.getAll()).toContain('deep-student');
    expect(skillDefaults.getAll()).not.toContain('deep-scholar');
  });
});
