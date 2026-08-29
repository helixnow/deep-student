import { describe, it, expect } from 'vitest';
import { generativeUIRegistry } from '@/features/generative-ui/registry';

// 触发内置块注册
import '@/features/generative-ui/blocks';

describe('generativeUIRegistry catalog', () => {
  it('every registered type has propsSchema and description for prompt catalog', () => {
    const all = generativeUIRegistry.getAll();
    expect(all.length).toBeGreaterThanOrEqual(14);

    for (const config of all) {
      expect(config.type).toBeTruthy();
      expect(config.propsSchema).toBeDefined();
      expect(config.propsSchema.safeParse({})).toBeDefined();
      expect(config.description?.length).toBeGreaterThan(0);
    }
  });

  it('getCatalogForPrompt lists all registered types', () => {
    const catalog = generativeUIRegistry.getCatalogForPrompt();
    const keys = generativeUIRegistry.keys();
    expect(catalog.length).toBe(keys.length);
    expect(keys.sort()).toEqual(expect.arrayContaining(['mindmap-embed', 'stat-card', 'action-bar']));
  });
});
