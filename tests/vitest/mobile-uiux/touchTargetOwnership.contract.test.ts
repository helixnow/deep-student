/**
 * 输入栏触控目标所有权契约（0824 Wave2-C R3 · TDD 先行）
 *
 * 关注「谁拥有这个命中区」而非「命中区有多大」：
 * - 每个触控控件的 testid 有且只有一个生产文件所有者（防拆分/重构时悄悄复制或丢失）；
 * - 水位环的命中区只有一个所有者（ContextUsagePopover 触发器使用共享尺寸
 *   token，ComposerToolbar 内环保持纯视觉）。
 *
 * 刻意不做「数有多少处 min-h-11」的尺寸计数断言：计数断言在无关重构时误报、
 * 在真正回归（比如把 min-h-11 挂错元素）时又照样通过，属于假保护。
 * 真实命中尺寸归 Playwright CT / 设计走查。
 *
 * ⚠️ 预期状态：机制落地后应全部转绿。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const INPUT_BAR_DIR = resolve(
  process.cwd(),
  'src/features/chat/components/input-bar'
);

const readInputBarSource = (file: string) =>
  readFileSync(join(INPUT_BAR_DIR, file), 'utf-8');

/** 递归列出 input-bar 生产源文件（排除 __tests__），返回相对 input-bar 的 posix 路径 */
const listProductionSources = (): string[] => {
  const files: string[] = [];
  const walk = (relativeDir: string): void => {
    for (const entry of readdirSync(join(INPUT_BAR_DIR, relativeDir), { withFileTypes: true })) {
      if (entry.name === '__tests__') continue;
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(relPath);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        files.push(relPath);
      }
    }
  };
  walk('');
  return files;
};

/**
 * 触控目标所有权登记表：testid → 唯一生产所有者文件。
 * 机制落地只允许换命中区实现，不允许挪走/复制/删除这些控件。
 */
const TOUCH_TARGET_OWNERS: Record<string, string[]> = {
  'ComposerToolbar.tsx': [
    'context-window-usage-control',
    'context-window-usage-ring',
    'thinking-runtime-control',
    'thinking-runtime-menu-trigger',
    'thinking-runtime-minimal-control',
    'btn-toggle-thinking',
    'btn-send',
    'btn-stop',
    'btn-send-disabled-hint',
  ],
  'ContextUsagePopover.tsx': [
    'context-usage-popover-trigger',
    'context-usage-compact-action',
  ],
  'ComposerPlusMenu.tsx': ['btn-toggle-attachments'],
};

const COARSE_MIN_H_TOKEN =
  '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]';
const COARSE_MIN_W_TOKEN =
  '[@media(pointer:coarse)]:min-w-[var(--touch-target-size)]';

describe('input-bar touch target ownership contract', () => {
  const productionSources = listProductionSources();
  const sourceByFile = new Map(
    productionSources.map((file) => [file, readInputBarSource(file)])
  );

  it('parses a non-empty production source list', () => {
    // 防空断言：目录移动/扫描失效时直接红，而不是让所有权断言空转通过
    expect(productionSources.length).toBeGreaterThan(0);
    expect(productionSources).toContain('ComposerToolbar.tsx');
    expect(productionSources).toContain('ContextUsagePopover.tsx');
  });

  it('keeps every registered touch target in its owner file', () => {
    for (const [ownerFile, testIds] of Object.entries(TOUCH_TARGET_OWNERS)) {
      const source = sourceByFile.get(ownerFile);
      expect(source, `${ownerFile} 应存在于 input-bar 生产源中`).toBeDefined();
      for (const testId of testIds) {
        expect(
          source,
          `${ownerFile} 应仍然拥有 data-testid="${testId}"`
        ).toContain(`data-testid="${testId}"`);
      }
    }
  });

  it('keeps exactly one production owner per registered touch target', () => {
    for (const testIds of Object.values(TOUCH_TARGET_OWNERS)) {
      for (const testId of testIds) {
        const owners = productionSources.filter((file) =>
          sourceByFile.get(file)!.includes(`data-testid="${testId}"`)
        );
        expect(
          owners,
          `data-testid="${testId}" 只允许一个生产所有者文件`
        ).toHaveLength(1);
      }
    }
  });

  it('keeps a token-sized popover trigger as the single hit-area owner', () => {
    const toolbarSource = sourceByFile.get('ComposerToolbar.tsx')!;
    const popoverSource = sourceByFile.get('ContextUsagePopover.tsx')!;

    const ringFnStart = toolbarSource.indexOf('function ContextWindowUsageRing');
    const ringFnEnd = toolbarSource.indexOf('export interface ComposerToolbarProps', ringFnStart);
    const triggerStart = popoverSource.indexOf('<AppMenuTrigger');
    const triggerEnd = popoverSource.indexOf('</AppMenuTrigger>', triggerStart);

    expect(ringFnStart).toBeGreaterThan(-1);
    expect(ringFnEnd).toBeGreaterThan(ringFnStart);
    expect(triggerStart).toBeGreaterThan(-1);
    expect(triggerEnd).toBeGreaterThan(triggerStart);

    const ringSlice = toolbarSource.slice(ringFnStart, ringFnEnd);
    const triggerSlice = popoverSource.slice(triggerStart, triggerEnd);
    expect(ringSlice).not.toContain('[@media(pointer:coarse)]');
    expect(triggerSlice).toContain(COARSE_MIN_H_TOKEN);
    expect(triggerSlice).toContain(COARSE_MIN_W_TOKEN);
  });

  it('keeps some coarse-pointer treatment in every owner file (mechanism-agnostic)', () => {
    // 只确认 coarse 触控机制仍存在（实尺寸/padding/伪元素均可），不数次数、不锁类名
    for (const ownerFile of Object.keys(TOUCH_TARGET_OWNERS)) {
      expect(
        sourceByFile.get(ownerFile),
        `${ownerFile} 应保留 coarse 指针的触控处理`
      ).toContain('[@media(pointer:coarse)]');
    }
  });
});
