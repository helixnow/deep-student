/**
 * agentFlash 单测 — R1-10
 * 覆盖：缺元素 no-op、属性设置与清理（jsdom）。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentFlash, agentFlashMany } from '../visuals/agentFlash';

describe('agentFlash', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('缺失元素时安全 no-op', () => {
    expect(() => agentFlash('todo', 'missing-id')).not.toThrow();
    expect(document.querySelector('[data-agent-flash]')).toBeNull();
  });

  it('找到元素时设置 data-agent-flash 并 scrollIntoView', () => {
    const row = document.createElement('div');
    row.setAttribute('data-agent-entity', 'todo:item-1');
    row.scrollIntoView = vi.fn();
    document.body.appendChild(row);

    agentFlash('todo', 'item-1');

    expect(row.hasAttribute('data-agent-flash')).toBe(true);
    expect(row.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      behavior: 'auto',
    });
  });

  it('options.scroll=false 时不调用 scrollIntoView', () => {
    const row = document.createElement('div');
    row.setAttribute('data-agent-entity', 'todo:no-scroll');
    row.scrollIntoView = vi.fn();
    document.body.appendChild(row);

    agentFlash('todo', 'no-scroll', { scroll: false });

    expect(row.hasAttribute('data-agent-flash')).toBe(true);
    expect(row.scrollIntoView).not.toHaveBeenCalled();
  });

  it('agentFlashMany：仅最后一项 scroll', () => {
    const rows = ['a', 'b', 'c'].map((id) => {
      const row = document.createElement('div');
      row.setAttribute('data-agent-entity', `todo:${id}`);
      row.scrollIntoView = vi.fn();
      document.body.appendChild(row);
      return row;
    });

    agentFlashMany('todo', ['a', 'b', 'c']);

    expect(rows[0]!.scrollIntoView).not.toHaveBeenCalled();
    expect(rows[1]!.scrollIntoView).not.toHaveBeenCalled();
    expect(rows[2]!.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      behavior: 'auto',
    });
    expect(document.querySelectorAll('[data-agent-flash]').length).toBe(3);
  });

  it('animationend 后移除 data-agent-flash', () => {
    const row = document.createElement('div');
    row.setAttribute('data-agent-entity', 'mindmap:n1');
    row.scrollIntoView = vi.fn();
    document.body.appendChild(row);

    agentFlash('mindmap', 'n1');
    expect(row.hasAttribute('data-agent-flash')).toBe(true);

    row.dispatchEvent(new Event('animationend'));
    expect(row.hasAttribute('data-agent-flash')).toBe(false);
  });

  it('800ms 兜底超时后移除属性', () => {
    const row = document.createElement('div');
    row.setAttribute('data-agent-entity', 'note:sec-a');
    row.scrollIntoView = vi.fn();
    document.body.appendChild(row);

    agentFlash('note', 'sec-a');
    expect(row.hasAttribute('data-agent-flash')).toBe(true);

    vi.advanceTimersByTime(800);
    expect(row.hasAttribute('data-agent-flash')).toBe(false);
  });

  it('reduced-motion：静态高亮约 400ms 清理且 scroll 仍为 auto', () => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('prefers-reduced-motion'),
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const row = document.createElement('div');
    row.setAttribute('data-agent-entity', 'todo:rm');
    row.scrollIntoView = vi.fn();
    document.body.appendChild(row);

    agentFlash('todo', 'rm');
    expect(row.hasAttribute('data-agent-flash')).toBe(true);
    expect(row.scrollIntoView).toHaveBeenCalledWith({
      block: 'nearest',
      behavior: 'auto',
    });

    vi.advanceTimersByTime(399);
    expect(row.hasAttribute('data-agent-flash')).toBe(true);
    vi.advanceTimersByTime(1);
    expect(row.hasAttribute('data-agent-flash')).toBe(false);
  });

  it('连续调用同元素先清后设（可重启动画）', () => {
    const row = document.createElement('div');
    row.setAttribute('data-agent-entity', 'todo:item-2');
    row.scrollIntoView = vi.fn();
    document.body.appendChild(row);

    agentFlash('todo', 'item-2');
    expect(row.hasAttribute('data-agent-flash')).toBe(true);

    agentFlash('todo', 'item-2');
    expect(row.hasAttribute('data-agent-flash')).toBe(true);
    expect(row.scrollIntoView).toHaveBeenCalledTimes(2);

    // 第二次的兜底计时仍能清理
    vi.advanceTimersByTime(800);
    expect(row.hasAttribute('data-agent-flash')).toBe(false);
  });

  it('对含特殊字符的 entityId 使用 CSS.escape 安全查询', () => {
    const row = document.createElement('div');
    const entityId = 'a:b"c';
    row.setAttribute('data-agent-entity', `files:${entityId}`);
    row.scrollIntoView = vi.fn();
    document.body.appendChild(row);

    expect(() => agentFlash('files', entityId)).not.toThrow();
    expect(row.hasAttribute('data-agent-flash')).toBe(true);
  });
});
