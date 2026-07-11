/**
 * O14 WallpaperLayer 测试：预设清单完整性 / 预设回退 / 图片适配层 /
 * 切换交叉淡入（animationend 回收 + 超时兜底）/ 动态流动预设
 */
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';

import {
  WallpaperLayer,
  WALLPAPER_PRESETS,
  DEFAULT_WALLPAPER,
  type WallpaperConfig,
} from '../WallpaperLayer';

function panesOf(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.wb-wallpaper-pane'));
}

afterEach(() => {
  vi.useRealTimers();
});

describe('壁纸预设清单', () => {
  it('至少 6 套预设且 id 唯一，沿用旧三套', () => {
    expect(WALLPAPER_PRESETS.length).toBeGreaterThanOrEqual(6);
    const ids = WALLPAPER_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['aurora', 'horizon', 'graphite']));
  });

  it('每套预设都有 workbench namespace 的 nameKey', () => {
    for (const preset of WALLPAPER_PRESETS) {
      expect(preset.nameKey).toMatch(/^workbench:wallpaper\./);
    }
  });

  it('至少一套动态流动预设', () => {
    expect(WALLPAPER_PRESETS.some((p) => p.animated)).toBe(true);
  });

  it('内置自然壁纸使用项目内静态资源，且默认选择薄雾雪山', () => {
    const naturalPresets = WALLPAPER_PRESETS.filter((preset) => preset.imageUrl);
    expect(naturalPresets).toHaveLength(4);
    expect(naturalPresets.every((preset) => preset.imageUrl?.startsWith('/wallpapers/study-os/')))
      .toBe(true);
    expect(DEFAULT_WALLPAPER).toEqual({ kind: 'theme', value: 'mountain-mist' });
  });
});

describe('主题渐变渲染', () => {
  it('缺省渲染默认预设单 pane', () => {
    const { container } = render(<WallpaperLayer />);
    const panes = panesOf(container);
    expect(panes).toHaveLength(1);
    expect(panes[0].getAttribute('data-wb-wallpaper-preset')).toBe(DEFAULT_WALLPAPER.value);
    expect(panes[0].classList.contains('wb-wallpaper-pane-enter')).toBe(false);
  });

  it('未知预设 id 回退默认', () => {
    const { container } = render(
      <WallpaperLayer wallpaper={{ kind: 'theme', value: 'not-a-preset' }} />,
    );
    expect(panesOf(container)[0].getAttribute('data-wb-wallpaper-preset')).toBe(
      DEFAULT_WALLPAPER.value,
    );
  });

  it('新增静态预设按 id 渲染', () => {
    const { container } = render(<WallpaperLayer wallpaper={{ kind: 'theme', value: 'meadow' }} />);
    expect(panesOf(container)[0].getAttribute('data-wb-wallpaper-preset')).toBe('meadow');
    expect(container.querySelectorAll('.wb-wallpaper-flow')).toHaveLength(0);
  });

  it('动态预设渲染三层流动光斑', () => {
    const { container } = render(
      <WallpaperLayer wallpaper={{ kind: 'theme', value: 'aurora-flow' }} />,
    );
    expect(panesOf(container)[0].getAttribute('data-wb-wallpaper-preset')).toBe('aurora-flow');
    expect(container.querySelectorAll('.wb-wallpaper-flow')).toHaveLength(3);
  });

  it('图片预设渲染内置资源、scrim 与暗角', () => {
    const { container } = render(
      <WallpaperLayer wallpaper={{ kind: 'theme', value: 'forest-mist' }} />,
    );
    const image = container.querySelector<HTMLElement>('.wb-wallpaper-image');
    expect(image?.style.backgroundImage).toContain('/wallpapers/study-os/forest-mist.webp');
    expect(container.querySelector('.wb-wallpaper-scrim')).not.toBeNull();
    expect(container.querySelector('.wb-wallpaper-vignette')).not.toBeNull();
  });
});

describe('自定义图片适配层', () => {
  it('默认：图片 + scrim + 暗角，无额外压暗，无模糊', () => {
    const { container } = render(
      <WallpaperLayer wallpaper={{ kind: 'image', value: '/wp/pic.jpg' }} />,
    );
    const image = container.querySelector<HTMLElement>('.wb-wallpaper-image');
    expect(image?.style.backgroundImage).toContain('/wp/pic.jpg');
    expect(image?.style.filter).toBe('');
    expect(container.querySelector('.wb-wallpaper-scrim')).not.toBeNull();
    expect(container.querySelector('.wb-wallpaper-vignette')).not.toBeNull();
    expect(container.querySelector('.wb-wallpaper-dimmer')).toBeNull();
  });

  it('url 中引号/反斜杠被转义', () => {
    const { container } = render(
      <WallpaperLayer wallpaper={{ kind: 'image', value: 'C:\\pics\\a"b.png' }} />,
    );
    const image = container.querySelector<HTMLElement>('.wb-wallpaper-image');
    expect(image?.style.backgroundImage).toContain('\\\\');
    expect(image?.style.backgroundImage).not.toBe('');
  });

  it('imageBlur/imageDim/imageVignette 可配且钳制', () => {
    const config: WallpaperConfig = {
      kind: 'image',
      value: '/wp/pic.jpg',
      imageBlur: 120, // 钳到 40
      imageDim: 0.3,
      imageVignette: false,
    };
    const { container } = render(<WallpaperLayer wallpaper={config} />);
    const image = container.querySelector<HTMLElement>('.wb-wallpaper-image');
    expect(image?.style.filter).toBe('blur(40px)');
    const dimmer = container.querySelector<HTMLElement>('.wb-wallpaper-dimmer');
    expect(dimmer?.style.opacity).toBe('0.3');
    expect(container.querySelector('.wb-wallpaper-vignette')).toBeNull();
  });

  it('空图片路径回退默认渐变', () => {
    const { container } = render(<WallpaperLayer wallpaper={{ kind: 'image', value: '' }} />);
    expect(panesOf(container)[0].getAttribute('data-wb-wallpaper-preset')).toBe(
      DEFAULT_WALLPAPER.value,
    );
  });
});

describe('切换交叉淡入', () => {
  it('配置变化 → 双 pane，新 pane 带 enter 动画类', () => {
    const { container, rerender } = render(
      <WallpaperLayer wallpaper={{ kind: 'theme', value: 'aurora' }} />,
    );
    rerender(<WallpaperLayer wallpaper={{ kind: 'theme', value: 'lagoon' }} />);
    const panes = panesOf(container);
    expect(panes).toHaveLength(2);
    expect(panes[0].getAttribute('data-wb-wallpaper-preset')).toBe('aurora');
    expect(panes[1].getAttribute('data-wb-wallpaper-preset')).toBe('lagoon');
    expect(panes[1].classList.contains('wb-wallpaper-pane-enter')).toBe(true);
  });

  it('淡入 animationend 后回收旧 pane', () => {
    const { container, rerender } = render(
      <WallpaperLayer wallpaper={{ kind: 'theme', value: 'aurora' }} />,
    );
    rerender(<WallpaperLayer wallpaper={{ kind: 'theme', value: 'sand' }} />);
    const top = panesOf(container)[1];
    fireEvent.animationEnd(top);
    const panes = panesOf(container);
    expect(panes).toHaveLength(1);
    expect(panes[0].getAttribute('data-wb-wallpaper-preset')).toBe('sand');
  });

  it('animationend 丢失时超时兜底回收（reduced-motion 场景）', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <WallpaperLayer wallpaper={{ kind: 'theme', value: 'aurora' }} />,
    );
    rerender(<WallpaperLayer wallpaper={{ kind: 'theme', value: 'nebula' }} />);
    expect(panesOf(container)).toHaveLength(2);
    act(() => {
      vi.advanceTimersByTime(700);
    });
    expect(panesOf(container)).toHaveLength(1);
    expect(panesOf(container)[0].getAttribute('data-wb-wallpaper-preset')).toBe('nebula');
  });

  it('视觉等价的配置变化不触发过渡', () => {
    const { container, rerender } = render(
      <WallpaperLayer wallpaper={DEFAULT_WALLPAPER} />,
    );
    // 新对象但同一预设 → 不追加 pane
    rerender(<WallpaperLayer wallpaper={{ ...DEFAULT_WALLPAPER }} />);
    expect(panesOf(container)).toHaveLength(1);
    // 未知 id 解析结果与当前相同 → 也不追加
    rerender(<WallpaperLayer wallpaper={{ kind: 'theme', value: 'bogus' }} />);
    expect(panesOf(container)).toHaveLength(1);
  });

  it('快速连续切换只保留上一层 + 最新层', () => {
    const { container, rerender } = render(
      <WallpaperLayer wallpaper={{ kind: 'theme', value: 'aurora' }} />,
    );
    rerender(<WallpaperLayer wallpaper={{ kind: 'theme', value: 'lagoon' }} />);
    rerender(<WallpaperLayer wallpaper={{ kind: 'theme', value: 'sakura' }} />);
    const panes = panesOf(container);
    expect(panes).toHaveLength(2);
    expect(panes[0].getAttribute('data-wb-wallpaper-preset')).toBe('lagoon');
    expect(panes[1].getAttribute('data-wb-wallpaper-preset')).toBe('sakura');
  });
});
