/**
 * ImageOcclusionOverlay 最小渲染层组件测试。
 */
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
// Mock i18n：词条与 zh-CN anki.json 的 agent.occlusion.revealBox 保持一致，
// 支持 {{index}} 插值；未知 key 回退 key 本身。
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'agent.occlusion.revealBox') {
        return `揭开遮挡区域 ${String(options?.index ?? '')}`;
      }
      return key;
    },
  }),
  initReactI18next: { type: '3rdParty', init: () => undefined },
}));

import { ImageOcclusionOverlay } from '../ImageOcclusionOverlay';
import type { OcclusionSpec } from '../utils/imageOcclusion';

const spec: OcclusionSpec = {
  imageRef: 'vfs://images/diagram.png',
  boxes: [
    { x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: '左心房', clozeIndex: 1 },
    { x: 0.5, y: 0.1, w: 0.2, h: 0.2, label: '右心室', clozeIndex: 2 },
    // 与盒 1 同组（Anki 语义：同 clozeIndex 一起揭开）
    { x: 0.1, y: 0.6, w: 0.2, h: 0.2, label: '左心房备注', clozeIndex: 1 },
  ],
};

describe('ImageOcclusionOverlay', () => {
  it('初始全部遮挡，百分比定位', () => {
    render(<ImageOcclusionOverlay spec={spec} />);
    const masked = screen.getAllByTestId('occlusion-box-masked');
    expect(masked).toHaveLength(3);
    expect(screen.queryAllByTestId('occlusion-box-revealed')).toHaveLength(0);
    // jsdom 会把 10.0000% 归一化为 10%
    expect(masked[0].style.left).toBe('10%');
    expect(masked[0].style.width).toBe('20%');
  });

  it('点击揭开同 clozeIndex 组，其余保持遮挡，并回调 onReveal', () => {
    const onReveal = vi.fn();
    render(<ImageOcclusionOverlay spec={spec} onReveal={onReveal} />);
    // clozeIndex=1 组内有两个盒，共享同一 aria-label，点其一即揭开整组
    fireEvent.click(screen.getAllByRole('button', { name: '揭开遮挡区域 1' })[0]);
    // clozeIndex=1 的两个盒一起揭开，显示标签
    const revealed = screen.getAllByTestId('occlusion-box-revealed');
    expect(revealed).toHaveLength(2);
    expect(screen.getByText('左心房')).toBeTruthy();
    expect(screen.getByText('左心房备注')).toBeTruthy();
    expect(screen.getAllByTestId('occlusion-box-masked')).toHaveLength(1);
    expect(onReveal).toHaveBeenCalledWith(1);
  });

  it('Enter 键揭开整个 cloze 组且只回调一次', async () => {
    const user = userEvent.setup();
    const onReveal = vi.fn();
    render(<ImageOcclusionOverlay spec={spec} onReveal={onReveal} />);

    const mask = screen.getAllByRole('button', { name: '揭开遮挡区域 1' })[0];
    mask.focus();
    await user.keyboard('{Enter}');

    expect(screen.getAllByTestId('occlusion-box-revealed')).toHaveLength(2);
    expect(screen.getAllByTestId('occlusion-box-masked')).toHaveLength(1);
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith(1);
  });

  it('空格键可揭开遮挡并阻止外层卡片键盘动作', async () => {
    const user = userEvent.setup();
    const onOuterKeyDown = vi.fn();
    const onReveal = vi.fn();
    render(
      <div onKeyDown={onOuterKeyDown}>
        <ImageOcclusionOverlay spec={spec} onReveal={onReveal} />
      </div>,
    );

    const mask = screen.getByRole('button', { name: '揭开遮挡区域 2' });
    mask.focus();
    await user.keyboard(' ');

    expect(screen.getByText('右心室')).toBeInTheDocument();
    expect(onReveal).toHaveBeenCalledTimes(1);
    expect(onReveal).toHaveBeenCalledWith(2);
    expect(onOuterKeyDown).not.toHaveBeenCalled();
  });

  it('非激活键不会揭开遮挡', () => {
    const onReveal = vi.fn();
    render(<ImageOcclusionOverlay spec={spec} onReveal={onReveal} />);

    fireEvent.keyDown(screen.getByRole('button', { name: '揭开遮挡区域 2' }), { key: 'ArrowRight' });

    expect(screen.getAllByTestId('occlusion-box-masked')).toHaveLength(3);
    expect(onReveal).not.toHaveBeenCalled();
  });

  it('受控模式只发出组序号，等待 revealedIndices 更新后再揭开', () => {
    const onReveal = vi.fn();
    const { rerender } = render(
      <ImageOcclusionOverlay
        spec={spec}
        revealedIndices={new Set<number>()}
        onReveal={onReveal}
      />,
    );

    fireEvent.click(screen.getAllByRole('button', { name: '揭开遮挡区域 1' })[1]);
    expect(onReveal).toHaveBeenCalledWith(1);
    expect(screen.getAllByTestId('occlusion-box-masked')).toHaveLength(3);

    rerender(
      <ImageOcclusionOverlay
        spec={spec}
        revealedIndices={new Set([1])}
        onReveal={onReveal}
      />,
    );
    expect(screen.getAllByTestId('occlusion-box-revealed')).toHaveLength(2);
  });

  it('revealAll 全部揭开；受控 revealedIndices 优先于内部状态', () => {
    const { rerender } = render(<ImageOcclusionOverlay spec={spec} revealAll />);
    expect(screen.getAllByTestId('occlusion-box-revealed')).toHaveLength(3);

    rerender(<ImageOcclusionOverlay spec={spec} revealedIndices={new Set([2])} />);
    expect(screen.getAllByTestId('occlusion-box-revealed')).toHaveLength(1);
    expect(screen.getByText('右心室')).toBeTruthy();
  });

  it('切换 spec 时不会沿用上一张卡的已揭答案', () => {
    const { rerender } = render(<ImageOcclusionOverlay spec={spec} />);
    fireEvent.click(screen.getAllByRole('button', { name: '揭开遮挡区域 1' })[0]);
    expect(screen.getAllByTestId('occlusion-box-revealed')).toHaveLength(2);

    const nextSpec: OcclusionSpec = {
      imageRef: 'vfs://images/next.png',
      boxes: [
        { x: 0.2, y: 0.2, w: 0.3, h: 0.3, label: '新卡答案', clozeIndex: 1 },
      ],
    };
    rerender(<ImageOcclusionOverlay spec={nextSpec} />);

    expect(screen.queryByText('新卡答案')).not.toBeInTheDocument();
    expect(screen.getAllByTestId('occlusion-box-masked')).toHaveLength(1);
  });

  it('在渲染边界过滤绕过 parser 的非法 spec', () => {
    const unsafeSpec = {
      imageRef: 'image.png',
      boxes: [
        { x: -5, y: 0, w: 10, h: 1, label: '越界', clozeIndex: 1 },
        { x: 0, y: 0, w: 0.25, h: 0.25, label: '合法', clozeIndex: 2 },
      ],
    } as OcclusionSpec;

    render(<ImageOcclusionOverlay spec={unsafeSpec} />);

    expect(screen.getAllByTestId('occlusion-box-masked')).toHaveLength(1);
    expect(screen.getByRole('button', { name: '揭开遮挡区域 2' })).toBeInTheDocument();
  });

  it('根结构非法或属性读取抛错时安全渲染空 overlay', () => {
    const throwingSpec = Object.defineProperty({}, 'imageRef', {
      get: () => {
        throw new Error('broken getter');
      },
    });

    const { rerender } = render(
      <ImageOcclusionOverlay spec={null as unknown as OcclusionSpec} />,
    );
    expect(screen.getByTestId('image-occlusion-overlay')).toBeEmptyDOMElement();

    expect(() => {
      rerender(<ImageOcclusionOverlay spec={throwingSpec as OcclusionSpec} />);
    }).not.toThrow();
    expect(screen.queryByTestId('occlusion-box-masked')).not.toBeInTheDocument();
  });

  it('揭开交互不会冒泡触发外层卡片翻面', () => {
    const onOuterClick = vi.fn();
    const onOuterKeyDown = vi.fn();
    render(
      <div onClick={onOuterClick} onKeyDown={onOuterKeyDown}>
        <ImageOcclusionOverlay spec={spec} />
      </div>,
    );

    const mask = screen.getAllByRole('button', { name: '揭开遮挡区域 1' })[0];
    fireEvent.keyDown(mask, { key: 'Enter' });
    fireEvent.click(mask);
    expect(onOuterKeyDown).not.toHaveBeenCalled();
    expect(onOuterClick).not.toHaveBeenCalled();

    fireEvent.click(screen.getAllByTestId('occlusion-box-revealed')[0]);
    expect(onOuterClick).not.toHaveBeenCalled();
  });
});
