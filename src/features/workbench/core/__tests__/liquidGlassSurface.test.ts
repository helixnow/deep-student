import { describe, it, expect } from 'vitest';
import { buildSurfaceDisplacementImageData } from '../liquidGlassSurface';

describe('liquidGlassSurface', () => {
  it('surface 档位支持大面板 0.5x 降采样并保持四周等厚向内折射', () => {
    // 880×620 > 45000 像素预算，自动 0.5x 烘焙 → 440×310
    const { width, height, data } = buildSurfaceDisplacementImageData(880, 620, 18, 'surface');
    expect(width).toBe(440);
    expect(height).toBe(310);

    const px = (x: number, y: number) => {
      const i = (y * width + x) * 4;
      return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] };
    };

    // 中心平坦区恒等
    expect(px(220, 155)).toEqual({ r: 128, g: 128, b: 128, a: 255 });
    // 顶/底/左/右倒角严格向内弯曲
    expect(px(220, 1).g).toBeGreaterThan(150);
    expect(px(220, height - 2).g).toBeLessThan(106);
    expect(px(1, 155).r).toBeGreaterThan(150);
    expect(px(width - 2, 155).r).toBeLessThan(106);
  });

  it('clear 档位中小尺寸保持 1:1 精确像素尺寸', () => {
    const { width, height } = buildSurfaceDisplacementImageData(280, 54, 17, 'clear');
    expect(width).toBe(280);
    expect(height).toBe(54);
  });

  it('widget 档位支持 24px 柔润圆角与四周等厚向内折射', () => {
    const { width, height, data } = buildSurfaceDisplacementImageData(320, 424, 24, 'widget');
    expect(width).toBe(160);
    expect(height).toBe(212);
    const center = (106 * width + 80) * 4;
    expect(data[center]).toBe(128);
    expect(data[center + 1]).toBe(128);
  });
});
