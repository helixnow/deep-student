/**
 * 图像遮挡最小渲染支持——纯函数测试。
 * 与 Rust 侧 anki_image_occlusion.rs 的契约测试互为镜像
 * （camelCase 字段名、像素换算保证、几何过滤语义）。
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_OCCLUSION_BOXES,
  MAX_OCCLUSION_LABEL_CHARS,
  OCCLUSION_FIELD,
  OCCLUSION_TAG,
  isOcclusionCard,
  normalizeOcclusionSpec,
  occlusionBoxPercentStyle,
  parseOcclusionSpec,
  toPixelRects,
  type OcclusionSpec,
} from '../imageOcclusion';

const validSpecJson = JSON.stringify({
  imageRef: 'vfs://images/diagram.png',
  boxes: [
    { x: 0.25, y: 0.5, w: 0.5, h: 0.25, label: '左心房', clozeIndex: 1 },
    { x: 0.0, y: 0.0, w: 0.2, h: 0.2, label: '右心室', clozeIndex: 2 },
  ],
});

describe('parseOcclusionSpec', () => {
  it('解析合法 _occlusion JSON（camelCase 契约）', () => {
    const spec = parseOcclusionSpec({ [OCCLUSION_FIELD]: validSpecJson });
    expect(spec).not.toBeNull();
    expect(spec!.imageRef).toBe('vfs://images/diagram.png');
    expect(spec!.boxes).toHaveLength(2);
    expect(spec!.boxes[0]).toMatchObject({ label: '左心房', clozeIndex: 1 });
  });

  it('缺字段 / 非法 JSON / 空 imageRef → null', () => {
    expect(parseOcclusionSpec(undefined)).toBeNull();
    expect(parseOcclusionSpec({})).toBeNull();
    expect(parseOcclusionSpec({ [OCCLUSION_FIELD]: 'not json' })).toBeNull();
    expect(
      parseOcclusionSpec({
        [OCCLUSION_FIELD]: JSON.stringify({ imageRef: '  ', boxes: [] }),
      }),
    ).toBeNull();
    expect(
      parseOcclusionSpec({
        [OCCLUSION_FIELD]: JSON.stringify({ imageRef: 'a.png', boxes: 'oops' }),
      }),
    ).toBeNull();
  });

  it('几何非法盒被过滤；全部非法 → null', () => {
    const mixed = JSON.stringify({
      imageRef: 'a.png',
      boxes: [
        { x: 0.9, y: 0.9, w: 0.5, h: 0.5, label: '越界', clozeIndex: 1 },
        { x: 0.1, y: 0.1, w: 0.2, h: 0.2, label: '合法', clozeIndex: 2 },
        { x: 0.1, y: 0.1, w: 0, h: 0.2, label: '零宽', clozeIndex: 3 },
      ],
    });
    const spec = parseOcclusionSpec({ [OCCLUSION_FIELD]: mixed });
    expect(spec!.boxes).toHaveLength(1);
    expect(spec!.boxes[0].label).toBe('合法');

    const allBad = JSON.stringify({
      imageRef: 'a.png',
      boxes: [{ x: -0.5, y: 0, w: 0.2, h: 0.2, label: 'x', clozeIndex: 1 }],
    });
    expect(parseOcclusionSpec({ [OCCLUSION_FIELD]: allBad })).toBeNull();
  });

  it('缺 clozeIndex 顺序补号、空标签补「区域 N」（与 Rust 归一化一致）', () => {
    const raw = JSON.stringify({
      imageRef: 'a.png',
      boxes: [
        { x: 0.0, y: 0.0, w: 0.2, h: 0.2, label: '', clozeIndex: 3 },
        { x: 0.5, y: 0.0, w: 0.2, h: 0.2 },
      ],
    });
    const spec = parseOcclusionSpec({ [OCCLUSION_FIELD]: raw })!;
    expect(spec.boxes[0].clozeIndex).toBe(3);
    expect(spec.boxes[0].label).toBe('区域 3');
    expect(spec.boxes[1].clozeIndex).toBe(4); // 已用最大序号 +1
  });

  it('收敛浮点边界、拒绝非法显式 clozeIndex，并限制盒数与标签长度', () => {
    const boxes = Array.from({ length: MAX_OCCLUSION_BOXES + 3 }, (_, index) => ({
      x: index === 1 ? -5e-7 : 0.1,
      y: 0.1,
      w: 0.2,
      h: 0.2,
      label: '心'.repeat(MAX_OCCLUSION_LABEL_CHARS + 10),
      clozeIndex: index === 0 ? 0 : index,
    }));
    const spec = normalizeOcclusionSpec({ imageRef: ' image.png ', boxes })!;

    // 显式 0 被拒绝；其余有效盒只接收后端上限，避免 DOM 放大。
    expect(spec.boxes).toHaveLength(MAX_OCCLUSION_BOXES);
    expect(spec.boxes.some((box) => box.clozeIndex === 0)).toBe(false);
    expect(spec.boxes[0].x).toBe(0);
    expect(Array.from(spec.boxes[0].label)).toHaveLength(MAX_OCCLUSION_LABEL_CHARS);
    expect(spec.imageRef).toBe('image.png');
  });

  it('补号到 MAX_SAFE_INTEGER 后回绕到可用安全正整数', () => {
    const spec = normalizeOcclusionSpec({
      imageRef: 'image.png',
      boxes: [
        {
          x: 0,
          y: 0,
          w: 0.2,
          h: 0.2,
          label: 'explicit',
          clozeIndex: Number.MAX_SAFE_INTEGER - 1,
        },
        { x: 0.25, y: 0, w: 0.2, h: 0.2, label: 'max-safe' },
        { x: 0.5, y: 0, w: 0.2, h: 0.2, label: 'wrapped' },
      ],
    })!;

    expect(spec.boxes.map((box) => box.clozeIndex)).toEqual([
      Number.MAX_SAFE_INTEGER - 1,
      Number.MAX_SAFE_INTEGER,
      1,
    ]);
    expect(spec.boxes.every((box) => Number.isSafeInteger(box.clozeIndex))).toBe(true);
  });

  it('异常属性访问安全降级为 null', () => {
    const broken = Object.defineProperty({}, 'imageRef', {
      get: () => {
        throw new Error('broken getter');
      },
    });

    expect(() => normalizeOcclusionSpec(broken)).not.toThrow();
    expect(normalizeOcclusionSpec(broken)).toBeNull();
  });
});

describe('toPixelRects', () => {
  const spec: OcclusionSpec = {
    imageRef: 'a.png',
    boxes: [{ x: 0.25, y: 0.5, w: 0.5, h: 0.25, label: 'L', clozeIndex: 1 }],
  };

  it('精确换算（800×600 → x=200 y=300 w=400 h=150），与 Rust 测试同数据', () => {
    const px = toPixelRects(spec, 800, 600);
    expect(px).toEqual([{ x: 200, y: 300, w: 400, h: 150, label: 'L', clozeIndex: 1 }]);
  });

  it('贴边收敛 + 最小 1px + 零尺寸图返回空', () => {
    const edge: OcclusionSpec = {
      imageRef: 'a.png',
      boxes: [
        { x: 0.9, y: 0.9, w: 0.1, h: 0.1, label: 'e', clozeIndex: 1 },
        { x: 0.5, y: 0.5, w: 0.011, h: 0.011, label: 't', clozeIndex: 2 },
      ],
    };
    const px = toPixelRects(edge, 3, 3);
    for (const p of px) {
      expect(p.w).toBeGreaterThanOrEqual(1);
      expect(p.h).toBeGreaterThanOrEqual(1);
      expect(p.x + p.w).toBeLessThanOrEqual(3);
      expect(p.y + p.h).toBeLessThanOrEqual(3);
    }
    expect(toPixelRects(edge, 0, 100)).toEqual([]);
    expect(toPixelRects(edge, NaN, 100)).toEqual([]);
  });
});

describe('occlusionBoxPercentStyle / isOcclusionCard', () => {
  it('百分比定位样式', () => {
    const style = occlusionBoxPercentStyle({
      x: 0.25,
      y: 0.5,
      w: 0.125,
      h: 0.1,
      label: 'L',
      clozeIndex: 1,
    });
    expect(style).toEqual({
      left: '25.0000%',
      top: '50.0000%',
      width: '12.5000%',
      height: '10.0000%',
    });
  });

  it('对绕过 parser 的非法几何返回零面积安全样式', () => {
    const style = occlusionBoxPercentStyle({
      x: -10,
      y: Number.POSITIVE_INFINITY,
      w: 50,
      h: 50,
      label: 'bad',
      clozeIndex: 1,
    });
    expect(style).toEqual({
      left: '0.0000%',
      top: '0.0000%',
      width: '0.0000%',
      height: '0.0000%',
    });
  });

  it('tag 或 _occlusion 字段任一命中即视为遮挡卡', () => {
    expect(isOcclusionCard([OCCLUSION_TAG], {})).toBe(true);
    expect(isOcclusionCard([], { [OCCLUSION_FIELD]: validSpecJson })).toBe(true);
    expect(isOcclusionCard(['other'], {})).toBe(false);
    expect(isOcclusionCard(undefined, undefined)).toBe(false);
  });
});
