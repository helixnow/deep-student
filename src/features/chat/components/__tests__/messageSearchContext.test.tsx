/**
 * messageSearchContext 回归测试
 *
 * Bug 背景：MessageSearchProvider 的 value 若每次渲染都是新对象，宿主
 * （MessageItem）因划词工具条显隐等本地状态重渲染时，context 传播会穿透
 * MarkdownRenderer 的 React.memo 强制其重渲染；其内联 components={{...}}
 * 随之生成全新函数引用，react-markdown 将所有 <p> 视为不同类型而卸载重建，
 * 选区锚定的文本节点被销毁——划词高亮在工具条弹出瞬间消失。
 *
 * 锁定契约：
 * 1. query 不变时 value 引用稳定（宿主重渲染不触发消费方重渲染）
 * 2. query 变化时 value 更新（搜索高亮功能正常）
 * 3. 宿主重渲染时 markdown 段落 DOM 节点保持同一引用（选区存活的物理基础）
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { MessageSearchProvider, useMessageSearchContext } from '../messageSearchContext';
import { MarkdownRenderer } from '../renderers/MarkdownRenderer';

describe('MessageSearchProvider', () => {
  it('query 不变时 value 引用稳定', () => {
    const seen: Array<{ query: string }> = [];
    const Probe: React.FC = () => {
      seen.push(useMessageSearchContext());
      return null;
    };
    const { rerender } = render(
      <MessageSearchProvider query="deep">
        <Probe />
      </MessageSearchProvider>
    );
    rerender(
      <MessageSearchProvider query="deep">
        <Probe />
      </MessageSearchProvider>
    );
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[seen.length - 1]).toBe(seen[0]);
  });

  it('query 变化时 value 更新', () => {
    const seen: Array<{ query: string }> = [];
    const Probe: React.FC = () => {
      seen.push(useMessageSearchContext());
      return null;
    };
    const { rerender } = render(
      <MessageSearchProvider query="a">
        <Probe />
      </MessageSearchProvider>
    );
    rerender(
      <MessageSearchProvider query="b">
        <Probe />
      </MessageSearchProvider>
    );
    expect(seen[seen.length - 1].query).toBe('b');
    expect(seen[seen.length - 1]).not.toBe(seen[0]);
  });

  it('宿主重渲染（query 不变）时 markdown 段落 DOM 节点保持同一引用', () => {
    const content = '第一段正文\n\n第二段正文';
    const { container, rerender } = render(
      <MessageSearchProvider query="">
        <MarkdownRenderer content={content} />
      </MessageSearchProvider>
    );
    const paragraphsBefore = Array.from(container.querySelectorAll('p'));
    expect(paragraphsBefore.length).toBe(2);

    // 模拟宿主因划词工具条显隐而重渲染：整棵子树以相同 props 重新下发
    rerender(
      <MessageSearchProvider query="">
        <MarkdownRenderer content={content} />
      </MessageSearchProvider>
    );

    const paragraphsAfter = Array.from(container.querySelectorAll('p'));
    expect(paragraphsAfter.length).toBe(2);
    // DOM 节点未被卸载重建——原生选区锚定的文本节点仍然存活
    paragraphsBefore.forEach((p, i) => expect(paragraphsAfter[i]).toBe(p));
  });
});
