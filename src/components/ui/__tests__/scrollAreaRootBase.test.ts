import { describe, expect, it } from 'vitest';
import { scrollAreaRootBase } from '../scroll-area';

describe('scrollAreaRootBase', () => {
  it('defaults to a relative root for the scrollbar track', () => {
    expect(scrollAreaRootBase()).toBe('relative min-h-0 min-w-0');
    expect(scrollAreaRootBase('h-full w-full')).toBe('relative min-h-0 min-w-0');
  });

  it('does not override an explicit positioning class from the caller', () => {
    // 导图「样式」面板传入 absolute：曾被追加的 relative 覆盖，面板退回文档流向上溢出
    expect(scrollAreaRootBase('absolute z-50 top-full right-0')).toBe('min-h-0 min-w-0');
    expect(scrollAreaRootBase('fixed inset-0')).toBe('min-h-0 min-w-0');
    expect(scrollAreaRootBase('sticky top-0')).toBe('min-h-0 min-w-0');
  });

  it('does not mistake look-alike utilities for positioning', () => {
    expect(scrollAreaRootBase('not-absolute-ish backdrop-absolute')).toBe('relative min-h-0 min-w-0');
  });
});
