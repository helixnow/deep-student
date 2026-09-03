import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// 粗指针（pointer:coarse）命中保底守卫。
//
// 根因：contract 里尺寸压缩只挂在 lg: 视口断点上，宽视口 + 粗指针
// （iPad 横屏等）会拿到 32px 命中区。修法是在每个 size 的 lg:h-* 之后
// 追加 [@media(pointer:coarse)]:min-h-[var(--touch-target-size)]（图标
// 尺寸再加 min-w），用 min-* 把「视觉高度」和「命中保底」分离：
// 细指针宽屏仍走 lg 压缩，桌面视觉不变。
//
// 本测试直接读 contract 源码做字符串级断言，不渲染组件。

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

const contractSource = readFileSync(
  path.join(repoRoot, 'src/components/ui/buttonPrimitiveContract.ts'),
  'utf8'
);

const COARSE_MIN_H = '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]';
const COARSE_MIN_W = '[@media(pointer:coarse)]:min-w-[var(--touch-target-size)]';

/** 提取 `export const <name>: Record<...> = { ... };` 的对象字面量文本。 */
function extractRecordBlock(source: string, constName: string): string {
  const match = source.match(
    new RegExp(`export const ${constName}[^=]*=\\s*\\{([\\s\\S]*?)\\n\\};`)
  );
  expect(match, `${constName} should exist in buttonPrimitiveContract.ts`).not.toBeNull();
  return match![1];
}

/** 提取块内某个 size key 的类名字符串（单引号字面量，可能跨行折行）。 */
function extractSizeClassName(block: string, sizeKey: string): string {
  const match = block.match(new RegExp(`${sizeKey}:\\s*\\n?\\s*'([^']*)'`));
  expect(match, `size "${sizeKey}" should have a string literal className`).not.toBeNull();
  return match![1];
}

const sizeKeys = ['default', 'sm', 'md', 'lg', 'icon'] as const;

describe('buttonPrimitiveContract coarse-pointer hit-area floor', () => {
  const sizeBlock = extractRecordBlock(contractSource, 'buttonSizeClassNames');
  const iconSizeBlock = extractRecordBlock(contractSource, 'buttonIconSizeClassNames');

  it('appends a coarse-pointer min-height floor after every lg compaction in buttonSizeClassNames', () => {
    sizeKeys.forEach((key) => {
      const className = extractSizeClassName(sizeBlock, key);
      expect(className, `buttonSizeClassNames.${key} keeps lg compaction`).toMatch(/\blg:h-\[var\(/);
      expect(className, `buttonSizeClassNames.${key} floors coarse hit height`).toContain(COARSE_MIN_H);
      expect(
        className.indexOf(COARSE_MIN_H),
        `buttonSizeClassNames.${key} coarse floor comes after lg compaction`
      ).toBeGreaterThan(className.indexOf('lg:h-['));
    });
  });

  it('floors both axes for square icon sizing (buttonIconSizeClassNames + size=icon)', () => {
    sizeKeys.forEach((key) => {
      const className = extractSizeClassName(iconSizeBlock, key);
      expect(className, `buttonIconSizeClassNames.${key} floors coarse height`).toContain(COARSE_MIN_H);
      expect(className, `buttonIconSizeClassNames.${key} floors coarse width`).toContain(COARSE_MIN_W);
    });

    const iconInSizeMap = extractSizeClassName(sizeBlock, 'icon');
    expect(iconInSizeMap, 'buttonSizeClassNames.icon floors coarse width too').toContain(COARSE_MIN_W);
  });

  it('separates visual height from hit floor: min-* only, never important height overrides', () => {
    // 全库 1335 处 !min-h-11 在补的洞，contract 层禁止再用 important 补。
    expect(contractSource).not.toContain('!min-h-11');
    expect(contractSource).not.toContain('!h-11');
    expect(contractSource).not.toMatch(/\[@media\(pointer:coarse\)\]:h-\[/);
  });

  it('keeps desktop fine-pointer compaction intact (no unconditional min-height floor)', () => {
    sizeKeys.forEach((key) => {
      const className = extractSizeClassName(sizeBlock, key);
      // 保底必须带 pointer:coarse 条件；裸 min-h-[var(--touch-target-size)]
      // 会把细指针桌面也顶到 44px，破坏 lg 压缩后的视觉。
      expect(
        className,
        `buttonSizeClassNames.${key} must not floor fine-pointer desktops`
      ).not.toMatch(/(?<!\[@media\(pointer:coarse\)\]:)\bmin-h-\[var\(--touch-target-size\)\]/);
    });
  });

  it('leaves tone classnames untouched by the coarse-pointer fix', () => {
    const toneBlock = extractRecordBlock(contractSource, 'buttonToneClassNames');
    expect(toneBlock).not.toContain('[@media(pointer:coarse)]');
  });
});
