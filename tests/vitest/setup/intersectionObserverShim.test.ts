import { describe, expect, it } from 'vitest';

// 锁定 vitest.setup.ts 提供的 IntersectionObserver 最小 shim：
// jsdom 不实现该 API，一旦 setup 里的 shim 被移除，依赖它的组件
// （NotesCrepeEditor / MindMapCanvas / PptxPreview / DocxPreview）
// 会在 mount 时以 ReferenceError 崩掉整个用例。
describe('IntersectionObserver shim (vitest.setup.ts)', () => {
  it('exists on globalThis after setup', () => {
    expect(globalThis.IntersectionObserver).toBeTypeOf('function');
  });

  it('can be constructed and exposes the four instance methods', () => {
    const observer = new IntersectionObserver(() => {});
    expect(observer.observe).toBeTypeOf('function');
    expect(observer.unobserve).toBeTypeOf('function');
    expect(observer.disconnect).toBeTypeOf('function');
    expect(observer.takeRecords).toBeTypeOf('function');

    const target = document.createElement('div');
    expect(() => {
      observer.observe(target);
      observer.unobserve(target);
      observer.disconnect();
    }).not.toThrow();
    expect(observer.takeRecords()).toEqual([]);
  });

  it('honors init options for root/rootMargin/thresholds', () => {
    const root = document.createElement('div');
    const observer = new IntersectionObserver(() => {}, {
      root,
      rootMargin: '10px',
      threshold: [0, 0.5, 1],
    });
    expect(observer.root).toBe(root);
    expect(observer.rootMargin).toBe('10px');
    expect(observer.thresholds).toEqual([0, 0.5, 1]);

    const defaults = new IntersectionObserver(() => {});
    expect(defaults.root).toBeNull();
    expect(defaults.rootMargin).toBe('0px');
    expect(defaults.thresholds).toEqual([0]);
  });
});
