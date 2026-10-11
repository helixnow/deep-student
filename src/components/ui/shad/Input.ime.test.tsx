import React, { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { Input } from './Input';

/** 模拟输入法往输入框里写组字内容：原生 setter 改值 + 派发 input 事件 */
function typeComposing(input: HTMLInputElement, value: string, isComposing: boolean) {
  fireEvent.input(input, { target: { value }, isComposing });
}

function Harness({
  onChange,
  transform = (v: string) => v,
}: {
  onChange?: (value: string) => void;
  transform?: (value: string) => string;
}) {
  const [query, setQuery] = useState('');
  return (
    <Input
      type="search"
      placeholder="search"
      value={query}
      onChange={(e) => {
        onChange?.(e.target.value);
        setQuery(transform(e.target.value));
      }}
    />
  );
}

describe('Input IME composition (#455)', () => {
  it('不在组字途中向父组件派发，也不改写 DOM 值；组字结束补发最终值', () => {
    const onChange = vi.fn();
    // 父组件会规范化（trim），组字中若回写会把正在组的内容改掉
    render(<Harness onChange={onChange} transform={(v) => v.trim()} />);
    const input = screen.getByPlaceholderText('search') as HTMLInputElement;

    fireEvent.compositionStart(input);
    typeComposing(input, 'h', true);
    typeComposing(input, 'he', true);
    typeComposing(input, 'hello ', true);

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('hello ');

    fireEvent.compositionEnd(input, { data: 'hello ' });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('hello ');
    // 组字结束后父组件的规范化值才生效
    expect(input.value).toBe('hello');
  });

  it('WebKit 在 compositionend 之后再派发的同值 input 不会重复触发 onChange', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByPlaceholderText('search') as HTMLInputElement;

    fireEvent.compositionStart(input);
    typeComposing(input, 'こんにちは', true);
    fireEvent.compositionEnd(input, { data: 'こんにちは' });
    typeComposing(input, 'こんにちは', false);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('こんにちは');

    // 之后的普通输入照常派发
    typeComposing(input, 'こんにちはa', false);
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(input.value).toBe('こんにちはa');
  });

  it('非组字输入逐次派发', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByPlaceholderText('search') as HTMLInputElement;

    fireEvent.change(input, { target: { value: 'a' } });
    fireEvent.change(input, { target: { value: 'ab' } });
    expect(onChange.mock.calls.map((c) => c[0])).toEqual(['a', 'ab']);
    expect(input.value).toBe('ab');
  });

  it('输入法丢失 compositionend 时，按原生 isComposing=false 恢复派发', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const input = screen.getByPlaceholderText('search') as HTMLInputElement;

    fireEvent.compositionStart(input);
    typeComposing(input, 'ab', true);
    typeComposing(input, 'abc', false);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith('abc');
    expect(input.value).toBe('abc');
  });

  it('组字中失焦时把已上屏内容交给父组件', () => {
    const onChange = vi.fn();
    const onBlur = vi.fn();
    function BlurHarness() {
      const [query, setQuery] = useState('');
      return (
        <Input
          placeholder="search"
          value={query}
          onBlur={onBlur}
          onChange={(e) => {
            onChange(e.target.value);
            setQuery(e.target.value);
          }}
        />
      );
    }
    render(<BlurHarness />);
    const input = screen.getByPlaceholderText('search') as HTMLInputElement;

    fireEvent.compositionStart(input);
    typeComposing(input, 'wor', true);
    fireEvent.blur(input);

    expect(onChange).toHaveBeenLastCalledWith('wor');
    expect(onBlur).toHaveBeenCalledTimes(1);
    expect(input.value).toBe('wor');
  });

  it('透传调用方自己的 composition 回调；非受控输入不受影响', () => {
    const onCompositionStart = vi.fn();
    const onCompositionEnd = vi.fn();
    const onChange = vi.fn();
    render(
      <Input
        placeholder="plain"
        defaultValue=""
        onChange={(e) => onChange(e.target.value)}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
      />
    );
    const input = screen.getByPlaceholderText('plain') as HTMLInputElement;

    fireEvent.compositionStart(input);
    typeComposing(input, 'x', true);
    fireEvent.compositionEnd(input);

    expect(onCompositionStart).toHaveBeenCalledTimes(1);
    expect(onCompositionEnd).toHaveBeenCalledTimes(1);
    // 非受控：原样派发（含组字中的事件），不做缓冲
    expect(onChange).toHaveBeenCalledWith('x');
  });
});
