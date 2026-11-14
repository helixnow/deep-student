import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { OverlayScrollbars } from 'overlayscrollbars';
import { afterEach, expect, it, vi } from 'vitest';
import { ScrollArea } from '../scroll-area';

afterEach(() => cleanup());

it('真实 OverlayScrollbars 在只读原型 focus 下挂载、卸载，不污染外部焦点', () => {
  const input = document.createElement('input');
  document.body.appendChild(input);
  input.focus();
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'focus')!;
  const focus = vi.fn(input.focus.bind(input));
  Object.defineProperty(HTMLElement.prototype, 'focus', { configurable: true, get: () => focus });
  try {
    const target = React.createRef<HTMLDivElement>();
    const view = render(<ScrollArea ref={target} nativeScrollbars={false}>内容</ScrollArea>);
    const instance = OverlayScrollbars(target.current!);
    expect(instance).toBeDefined();
    expect(instance!.state().destroyed).toBe(false);
    expect(Object.hasOwn(input, 'focus')).toBe(false);

    view.unmount();

    expect(instance!.state().destroyed).toBe(true);
    expect(focus).not.toHaveBeenCalled();
    expect(Object.hasOwn(input, 'focus')).toBe(false);
    expect(document.activeElement).toBe(input);
    input.focus();
    expect(focus).toHaveBeenCalledTimes(1);
  } finally {
    cleanup();
    Object.defineProperty(HTMLElement.prototype, 'focus', descriptor);
    input.remove();
  }
});
