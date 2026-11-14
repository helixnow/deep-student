/**
 * OverlayScrollbars 初始化、销毁结束时都会对当前焦点元素再调一次 focus()；焦点在目标之外时这是空操作，
 * 却要强制结算整份文档的样式与布局（虚拟列表滚动时每行挂载/卸载各一次）。ScrollArea 只在焦点位于目标之外时跳过它。
 *
 * mock 照真实库的两点行为：overlayscrollbars-react 的 hook 自带卸载清理（先于 ScrollArea 的 effect 清理执行）
 * 直接 destroy；实例的初始化与 destroy 结尾对 document.activeElement 调 focus()。
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

const { afterRefocus } = vi.hoisted(() => ({ afterRefocus: vi.fn() }));

vi.mock('overlayscrollbars-react', async () => {
  const ReactModule = await import('react');
  const refocusActive = () => {
    (document.activeElement as HTMLElement | null)?.focus({ preventScroll: true });
    afterRefocus();
  };
  const createInstance = (target: HTMLElement) => {
    let destroyed = false;
    return {
      state: () => ({ destroyed }),
      elements: () => ({ target }),
      destroy: () => {
        if (destroyed) return;
        destroyed = true;
        refocusActive();
      },
    };
  };
  type Instance = ReturnType<typeof createInstance>;
  return {
    useOverlayScrollbars: () => {
      const instanceRef = ReactModule.useRef<Instance | null>(null);
      ReactModule.useEffect(() => () => instanceRef.current?.destroy(), []);
      return ReactModule.useMemo(() => [
        ({ target }: { target: HTMLElement }) => {
          if (instanceRef.current && !instanceRef.current.state().destroyed) return;
          instanceRef.current = createInstance(target);
          refocusActive();
        },
        () => instanceRef.current,
      ], []);
    },
  };
});

import { ScrollArea } from '../scroll-area';

afterEach(() => {
  cleanup();
  afterRefocus.mockReset();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

function focusOutsideInput(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  expect(document.activeElement).toBe(input);
  return input;
}

describe('ScrollArea：OverlayScrollbars 的焦点回填', () => {
  it.each([false, true])('库抛错仍恢复外部 focus（自身 descriptor：%s）', (own) => {
    const input = focusOutsideInput();
    const focus = input.focus;
    if (own) Object.defineProperty(input, 'focus', { configurable: true, get: () => focus });
    const descriptor = Object.getOwnPropertyDescriptor(input, 'focus');
    const view = render(<ScrollArea nativeScrollbars={false}>内容</ScrollArea>);
    afterRefocus.mockImplementationOnce(() => { throw new Error('destroy failed'); });

    expect(() => view.unmount()).toThrow('destroy failed');
    expect(Object.getOwnPropertyDescriptor(input, 'focus')).toEqual(descriptor);
    expect(input.focus).toBe(focus);
    expect(document.activeElement).toBe(input);
  });

  it('继承只读 focus accessor：挂载与真实 React 卸载均遮蔽并删除临时属性', () => {
    const input = focusOutsideInput();
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus')!;
    const focus = vi.fn(input.focus.bind(input));
    const descriptor = { configurable: true, get: () => focus };
    Object.defineProperty(HTMLElement.prototype, 'focus', descriptor);
    try {
      const view = render(<ScrollArea nativeScrollbars={false}>内容</ScrollArea>);
      expect(Object.hasOwn(input, 'focus')).toBe(false);
      view.unmount();
      expect(focus).not.toHaveBeenCalled();
      expect(Object.hasOwn(input, 'focus')).toBe(false);
      expect(Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus')).toMatchObject(descriptor);
      expect(document.activeElement).toBe(input);
      input.focus();
      expect(focus).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'focus', original);
    }
  });

  it.each(['accessor', 'data'] as const)('自身 %s focus descriptor 在挂载和卸载后原样恢复', (kind) => {
    const input = focusOutsideInput();
    const focus = vi.fn(input.focus.bind(input));
    Object.defineProperty(input, 'focus', kind === 'accessor'
      ? { configurable: true, enumerable: true, get: () => focus }
      : { configurable: true, enumerable: true, writable: false, value: focus });
    const descriptor = Object.getOwnPropertyDescriptor(input, 'focus');

    const view = render(<ScrollArea nativeScrollbars={false}>内容</ScrollArea>);
    expect(Object.getOwnPropertyDescriptor(input, 'focus')).toEqual(descriptor);
    view.unmount();
    expect(Object.getOwnPropertyDescriptor(input, 'focus')).toEqual(descriptor);
    expect(focus).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input);
    input.focus();
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('不可配置的自身 focus 不被改写，库仍完成初始化与销毁', () => {
    const input = focusOutsideInput();
    const focus = vi.fn(input.focus.bind(input));
    Object.defineProperty(input, 'focus', { configurable: false, get: () => focus });
    const descriptor = Object.getOwnPropertyDescriptor(input, 'focus');
    const view = render(<ScrollArea nativeScrollbars={false}>内容</ScrollArea>);
    view.unmount();
    expect(focus).toHaveBeenCalledTimes(2);
    expect(Object.getOwnPropertyDescriptor(input, 'focus')).toEqual(descriptor);
  });

  it('焦点在目标之外：初始化不再对它调 focus()，结束后不留实例属性', () => {
    const input = focusOutsideInput();
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');

    render(<ScrollArea nativeScrollbars={false}>内容</ScrollArea>);

    expect(focus).not.toHaveBeenCalled();
    expect(Object.prototype.hasOwnProperty.call(input, 'focus')).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('焦点在目标之外：卸载（库自带清理先执行的路径）也不调 focus()', () => {
    const input = focusOutsideInput();
    const view = render(<ScrollArea nativeScrollbars={false}>内容</ScrollArea>);
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');

    view.unmount();

    expect(focus).not.toHaveBeenCalled();
    expect(Object.prototype.hasOwnProperty.call(input, 'focus')).toBe(false);
    expect(document.activeElement).toBe(input);
  });

  it('焦点在目标之内：照常回填', () => {
    const focus = vi.spyOn(HTMLElement.prototype, 'focus');

    const view = render(
      <ScrollArea nativeScrollbars={false}>
        <button type="button" ref={(el) => el?.focus()}>里面</button>
      </ScrollArea>,
    );
    const button = view.getByRole('button');

    expect(focus.mock.contexts.filter((el) => el === button).length).toBeGreaterThanOrEqual(2);
  });
});
