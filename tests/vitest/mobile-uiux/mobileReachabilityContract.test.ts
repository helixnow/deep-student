import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * 移动端可达性契约（2026-08 移动端 UI/UX 统一）
 *
 * 每个 CurrentView 必须至少落入以下三桶之一，杜绝“进不去/出不来”的孤岛视图：
 * 1) F1 抽屉导航：config/navigation.ts 共享导航项 + MOBILE_APP_LAUNCHER_VIEWS
 *    （2026-09 启动器收口后的移动抽屉二行三列入口）+ MobileSidebarNavigation 手工项；
 * 2) 命令面板：src/command-palette 各 module 中 deps.navigate('view') 的跳转目标；
 * 3) 上下文/DEV 入口 allowlist：由其他视图内的按钮或 DEV 工具跳转抵达。
 *
 * 废弃别名例外：仍留在 CurrentView 联合里、但已被 canonicalizeView 字符串级
 * 重定向的视图（如 dashboard → data-management，2026-09 启动器收口时废弃）
 * 不是孤岛——任何 navigate('dashboard') 都会落到可达的规范视图。这类视图
 * 不要求自有入口，但其重定向目标必须可达。
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

/** 解析 config/navigation.ts 的 MOBILE_APP_LAUNCHER_VIEWS 数组（移动抽屉启动器入口） */
const parseLauncherViews = (sharedNavSource: string): string[] => {
  const block = sharedNavSource.match(/MOBILE_APP_LAUNCHER_VIEWS\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  return collectMatches(block, /'([a-z0-9-]+)'/g);
};

/**
 * 解析 canonicalView.ts 的 DEPRECATED_VIEW_MAP：仍留在 CurrentView 联合里的
 * 废弃别名 → 重定向目标。键可能不带引号（analysis: 'chat-v2'）或带引号
 * （'llm-usage-stats': 'data-management'）。
 */
const parseDeprecatedViewMap = (canonicalSource: string): Map<string, string> => {
  const block = canonicalSource.match(/DEPRECATED_VIEW_MAP[^=]*=\s*\{([\s\S]*?)\};/)?.[1] ?? '';
  return new Map(
    [...block.matchAll(/'?([a-z0-9-]+)'?\s*:\s*'([a-z0-9-]+)'/g)].map(
      (match) => [match[1], match[2]] as const,
    ),
  );
};

describe('mobile reachability contract', () => {
  const currentViews = parseCurrentViews();

  const sharedNavSource = readSource('src/config/navigation.ts');
  const mobileSidebarSource = readSource('src/components/layout/MobileSidebarNavigation.tsx');
  const canonicalSource = readSource('src/app/navigation/canonicalView.ts');

  const drawerViews = new Set([
    ...collectMatches(sharedNavSource, NAV_ITEM_VIEW_LITERAL),
    ...parseLauncherViews(sharedNavSource),
    ...collectMatches(mobileSidebarSource, NAV_ITEM_VIEW_LITERAL),
  ]);

  const deprecatedViewMap = parseDeprecatedViewMap(canonicalSource);

  const paletteViews = new Set(
    listFiles('src/command-palette')
      .filter((file) => CODE_FILE_PATTERN.test(file))
      .flatMap((file) => collectMatches(readSource(file), PALETTE_NAVIGATE_LITERAL)),
  );

  const isReachable = (view: string): boolean =>
    drawerViews.has(view) || paletteViews.has(view) || CONTEXTUAL_ENTRY_VIEWS.has(view);

  it('keeps the mobile drawer launcher entry for data-management (dashboard deprecated)', () => {
    // F1 后续（2026-09 启动器收口 86212dbbd）：dashboard 视图已废弃，
    // canonicalizeView 字符串级重定向到 data-management；移动端入口统一收口进
    // MOBILE_APP_LAUNCHER_VIEWS，抽屉只保留「数据」一格，不再有独立「总览」入口。
    expect(mobileSidebarSource).toContain('MOBILE_APP_LAUNCHER_VIEWS');
    expect(deprecatedViewMap.get('dashboard')).toBe('data-management');
    expect(drawerViews.has('data-management')).toBe(true);
    expect(drawerViews.has('dashboard')).toBe(false);
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
    // 废弃别名（dashboard 等）由 canonicalizeView 重定向，不算孤岛；
    // 但其重定向目标必须可达，否则历史记录里的旧视图会落到空白页。
    const unreachable = currentViews.filter(
      (view) => !deprecatedViewMap.has(view) && !isReachable(view),
    );
    const orphanedRedirects = currentViews.filter(
      (view) => deprecatedViewMap.has(view) && !isReachable(deprecatedViewMap.get(view)!),
    );

    expect(unreachable).toEqual([]);
    expect(orphanedRedirects).toEqual([]);
  });
});
