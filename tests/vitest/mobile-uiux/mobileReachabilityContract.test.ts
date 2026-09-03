import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * 移动端可达性契约（2026-08 移动端 UI/UX 统一）
 *
 * 每个 CurrentView 必须至少落入以下三桶之一，杜绝“进不去/出不来”的孤岛视图：
 * 1) F1 抽屉导航：config/navigation.ts 共享导航项 + MobileSidebarNavigation 的
 *    移动端专属管理项（dashboard / data-management）；
 * 2) 命令面板：src/command-palette 各 module 中 deps.navigate('view') 的跳转目标；
 * 3) 上下文/DEV 入口 allowlist：由其他视图内的按钮或 DEV 工具跳转抵达。
 */

const ROOT = process.cwd();

const readSource = (relPath: string): string =>
  readFileSync(resolve(ROOT, relPath), 'utf-8');

/** 递归列出目录下所有文件，返回相对仓库根的 posix 风格路径 */
const listFiles = (dir: string): string[] => {
  const files: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        files.push(relative(ROOT, fullPath).split('\\').join('/'));
      }
    }
  };
  walk(resolve(ROOT, dir));
  return files;
};

/** 从 src/types/navigation.ts 的类型联合中解析 CurrentView 字面量 */
const parseCurrentViews = (): string[] => {
  const navigationTypesSource = readSource('src/types/navigation.ts');
  const unionBlock = navigationTypesSource.match(/export type CurrentView =([\s\S]*?);/)?.[1] ?? '';
  return [...unionBlock.matchAll(/'([a-z0-9-]+)'/g)].map((match) => match[1]);
};

const CODE_FILE_PATTERN = /\.(ts|tsx|js|jsx)$/;

/**
 * 上下文/DEV 入口 allowlist：这些视图没有（也不需要）抽屉/命令面板常驻入口，
 * 依靠页面内上下文按钮或 DEV 工具抵达。新增视图默认不进此桶——
 * 要么加进抽屉/命令面板，要么在这里登记并说明入口。
 */
const CONTEXTUAL_ENTRY_VIEWS = new Set([
  'pdf-reader',            // 学习资源/文件上下文打开 PDF 阅读器
  'template-json-preview', // 模板管理内的 JSON 预览入口
  'sandbox-workbench',     // Chat 沙箱上下文入口
  'crepe-demo',            // DEV：Crepe 编辑器演示
  'chat-v2-test',          // DEV：Chat V2 集成测试页
  'llm-playground',        // DEV：LLM 输出模拟游乐场
]);

/** 匹配 view: 'xxx'（含 view: 'xxx' as CurrentView / as NavViewType） */
const NAV_ITEM_VIEW_LITERAL = /view:\s*'([a-z0-9-]+)'/g;
/** 匹配命令面板里的 deps.navigate('xxx') */
const PALETTE_NAVIGATE_LITERAL = /deps\.navigate\(\s*'([a-z0-9-]+)'/g;

const collectMatches = (source: string, pattern: RegExp): string[] =>
  [...source.matchAll(pattern)].map((match) => match[1]);

describe('mobile reachability contract', () => {
  const currentViews = parseCurrentViews();

  const sharedNavSource = readSource('src/config/navigation.ts');
  const mobileSidebarSource = readSource('src/components/layout/MobileSidebarNavigation.tsx');

  const drawerViews = new Set([
    ...collectMatches(sharedNavSource, NAV_ITEM_VIEW_LITERAL),
    ...collectMatches(mobileSidebarSource, NAV_ITEM_VIEW_LITERAL),
  ]);

  const paletteViews = new Set(
    listFiles('src/command-palette')
      .filter((file) => CODE_FILE_PATTERN.test(file))
      .flatMap((file) => collectMatches(readSource(file), PALETTE_NAVIGATE_LITERAL)),
  );

  it('keeps the F1 drawer entries for dashboard and data-management in MobileSidebarNavigation', () => {
    // F1（移动端审计）：这两个视图在桌面侧栏之外只有抽屉「管理」分组这一个移动端入口
    expect(mobileSidebarSource).toContain("view: 'dashboard' as CurrentView");
    expect(mobileSidebarSource).toContain("view: 'data-management' as CurrentView");
    expect(drawerViews.has('dashboard')).toBe(true);
    expect(drawerViews.has('data-management')).toBe(true);
  });

  it('parses non-empty drawer and command palette buckets', () => {
    // 防空断言：解析失效时直接红，而不是让主断言空转通过
    expect(drawerViews.size).toBeGreaterThan(0);
    expect(paletteViews.size).toBeGreaterThan(0);
    expect(drawerViews.has('chat-v2')).toBe(true);
    expect(drawerViews.has('settings')).toBe(true);
  });

  it('only targets valid CurrentView ids from drawer, palette, and contextual allowlist', () => {
    const viewSet = new Set(currentViews);

    const invalidDrawer = [...drawerViews].filter((view) => !viewSet.has(view));
    const invalidPalette = [...paletteViews].filter((view) => !viewSet.has(view));
    // allowlist 条目过期（视图已删除）时必须同步清理
    const staleContextual = [...CONTEXTUAL_ENTRY_VIEWS].filter((view) => !viewSet.has(view));

    expect(invalidDrawer).toEqual([]);
    expect(invalidPalette).toEqual([]);
    expect(staleContextual).toEqual([]);
  });

  it('makes every CurrentView reachable via drawer, command palette, or contextual allowlist', () => {
    const unreachable = currentViews.filter(
      (view) => !drawerViews.has(view) && !paletteViews.has(view) && !CONTEXTUAL_ENTRY_VIEWS.has(view),
    );

    expect(unreachable).toEqual([]);
  });
});
