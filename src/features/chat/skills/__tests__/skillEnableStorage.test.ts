import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SkillDefinition } from '../types';

const STORAGE_KEY = 'deep-student.skill-enable-overrides';

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

function installStorage(initial: Record<string, string> = {}): void {
  Object.defineProperty(globalThis, 'localStorage', {
    value: createStorage(initial),
    configurable: true,
    writable: true,
  });
}

function createSkill(id: string): SkillDefinition {
  return {
    id,
    name: id,
    description: 'test skill for enable storage',
    content: '# instructions',
    sourcePath: `/skills/${id}/SKILL.md`,
    location: 'global',
  };
}

describe('skillEnableStorage', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    installStorage();
  });

  it('defaults to enabled when no override exists', async () => {
    const { isSkillDisabled } = await import('../skillEnableStorage');

    expect(isSkillDisabled('any-skill')).toBe(false);
  });

  it('persists disabled override and reads it back', async () => {
    const { isSkillDisabled, setSkillDisabled } = await import('../skillEnableStorage');

    setSkillDisabled('pdf-tools', true);

    expect(isSkillDisabled('pdf-tools')).toBe(true);
    expect(isSkillDisabled('other-skill')).toBe(false);
    expect(JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY)!)).toEqual({
      'pdf-tools': true,
    });
  });

  it('removes the override entry when re-enabled', async () => {
    const { isSkillDisabled, setSkillDisabled } = await import('../skillEnableStorage');

    setSkillDisabled('pdf-tools', true);
    setSkillDisabled('workspace-tools', true);
    setSkillDisabled('pdf-tools', false);

    expect(isSkillDisabled('pdf-tools')).toBe(false);
    expect(isSkillDisabled('workspace-tools')).toBe(true);
    expect(JSON.parse(globalThis.localStorage.getItem(STORAGE_KEY)!)).toEqual({
      'workspace-tools': true,
    });
  });

  it('gracefully ignores corrupted storage payloads', async () => {
    installStorage({ [STORAGE_KEY]: 'not-json{' });
    const { isSkillDisabled, setSkillDisabled } = await import('../skillEnableStorage');

    expect(isSkillDisabled('any-skill')).toBe(false);

    // 写入应重建为合法 map
    setSkillDisabled('any-skill', true);
    expect(isSkillDisabled('any-skill')).toBe(true);
  });

  it('treats non-object payloads (array) as empty overrides', async () => {
    installStorage({ [STORAGE_KEY]: JSON.stringify(['pdf-tools']) });
    const { isSkillDisabled } = await import('../skillEnableStorage');

    expect(isSkillDisabled('pdf-tools')).toBe(false);
  });

  it('applyEnableOverride attaches disabled flag without mutating the input', async () => {
    const { applyEnableOverride, setSkillDisabled } = await import('../skillEnableStorage');

    const skill = createSkill('canvas-note');

    const enabled = applyEnableOverride(skill);
    expect(enabled.disabled).toBe(false);

    setSkillDisabled('canvas-note', true);
    const disabled = applyEnableOverride(skill);
    expect(disabled.disabled).toBe(true);

    // 原对象不被修改
    expect(skill.disabled).toBeUndefined();
    // 其他字段原样保留
    expect(disabled.id).toBe('canvas-note');
    expect(disabled.content).toBe('# instructions');
  });

  it('dispatches SKILL_ENABLED_CHANGED with skillId and disabled state', async () => {
    const { setSkillDisabled, SKILL_ENABLED_CHANGED_EVENT } = await import('../skillEnableStorage');

    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');

    setSkillDisabled('web-fetch', true);
    const disableEvent = dispatchSpy.mock.calls.at(-1)?.[0] as CustomEvent;
    expect(disableEvent.type).toBe(SKILL_ENABLED_CHANGED_EVENT);
    expect(disableEvent.detail).toEqual({ skillId: 'web-fetch', disabled: true });

    setSkillDisabled('web-fetch', false);
    const enableEvent = dispatchSpy.mock.calls.at(-1)?.[0] as CustomEvent;
    expect(enableEvent.type).toBe(SKILL_ENABLED_CHANGED_EVENT);
    expect(enableEvent.detail).toEqual({ skillId: 'web-fetch', disabled: false });
  });
});
