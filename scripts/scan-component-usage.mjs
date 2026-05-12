#!/usr/bin/env node
/**
 * scan-component-usage.mjs
 * 扫描 src/ 下的组件使用情况，生成 JSON 统计数据供 StyleDebugPage 消费。
 *
 * 输出: src/components/style-lab/scan-data.json
 *
 * 用法:
 *   node scripts/scan-component-usage.mjs
 *   # 或在 dev 启动前自动执行（见 package.json scripts）
 */

import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, extname } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const SRC = join(ROOT, 'src');
const OUTPUT = join(SRC, 'components/style-lab/scan-data.json');

// 排除目录
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'test-results',
  'src/debug-panel', 'src/mcp-debug', 'src/components/dev',
]);

// 只扫描这些扩展名
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css']);

// 这些文件是颜色 token 源，允许承载原始色值；消费侧文件才算硬编码债务。
const SEMANTIC_COLOR_SOURCE_FILES = new Set([
  'src/styles/shadcn-variables.css',
  'src/styles/theme-colors.css',
]);

// ─── 扫描目标定义 ───────────────────────────────────────────────

/** @type {Array<{id: string, label: string, target: boolean, patterns: RegExp[]}>} */
const COMPONENT_TARGETS = [
  // Buttons
  { id: 'NotionButton', label: 'NotionButton', target: true, patterns: [/\bNotionButton\b/g] },
  { id: 'ShadButton', label: 'shad Button', target: false, patterns: [/from\s+['"]@\/components\/ui\/shad\/Button['"]/g] },
  { id: 'NativeButton', label: '原生 <button>', target: false, patterns: [/<button[\s>]/g] },

  // Form controls
  { id: 'ShadInput', label: 'shad Input', target: true, patterns: [/from\s+['"]@\/components\/ui\/shad\/Input['"]/g] },
  { id: 'ShadTextarea', label: 'shad Textarea', target: true, patterns: [/from\s+['"]@\/components\/ui\/shad\/Textarea['"]/g] },
  { id: 'ShadSwitch', label: 'shad Switch', target: true, patterns: [/from\s+['"]@\/components\/ui\/shad\/Switch['"]/g] },
  { id: 'ShadCheckbox', label: 'shad Checkbox', target: true, patterns: [/from\s+['"]@\/components\/ui\/shad\/Checkbox['"]/g] },
  { id: 'AppSelect', label: 'AppSelect', target: false, patterns: [/\bAppSelect\b/g] },
  { id: 'NativeInput', label: '原生 <input>', target: false, patterns: [/<input[\s>]/g] },
  { id: 'NativeSelect', label: '原生 <select>', target: false, patterns: [/<select[\s>]/g] },
  { id: 'NativeTextarea', label: '原生 <textarea>', target: false, patterns: [/<textarea[\s>]/g] },

  // Dialog / Overlay
  { id: 'NotionDialog', label: 'NotionDialog', target: true, patterns: [/\bNotionDialog\b/g] },
  { id: 'ShadDialog', label: 'shad Dialog', target: false, patterns: [/from\s+['"]@\/components\/ui\/shad\/Dialog['"]/g] },
  { id: 'ShadSheet', label: 'shad Sheet', target: false, patterns: [/from\s+['"]@\/components\/ui\/shad\/Sheet['"]/g] },
  { id: 'AppMenu', label: 'AppMenu', target: false, patterns: [/\bAppMenu\b/g] },

  // Surface / Card
  { id: 'ShadCard', label: 'shad Card', target: true, patterns: [/from\s+['"]@\/components\/ui\/shad\/Card['"]/g] },

  // Tabs
  { id: 'ShadTabs', label: 'shad Tabs', target: true, patterns: [/from\s+['"]@\/components\/ui\/shad\/Tabs['"]/g] },

  // Scroll
  { id: 'CustomScrollArea', label: 'CustomScrollArea', target: true, patterns: [/\bCustomScrollArea\b/g] },

  // Tooltip
  { id: 'CommonTooltip', label: 'CommonTooltip', target: true, patterns: [/\bCommonTooltip\b/g] },
  { id: 'ShadTooltip', label: 'shad Tooltip', target: false, patterns: [/from\s+['"]@\/components\/ui\/shad\/Tooltip['"]/g] },

  // Notification
  { id: 'UnifiedNotification', label: 'UnifiedNotification', target: true, patterns: [/\bUnifiedNotification\b|\bshowGlobalNotification\b/g] },

  // Icons
  { id: 'LucideIcons', label: 'lucide-react', target: false, patterns: [/from\s+['"]lucide-react['"]/g] },
  { id: 'PhosphorIcons', label: 'Phosphor', target: true, patterns: [/from\s+['"]@phosphor-icons/g] },

  // Sidebar
  { id: 'UnifiedSidebar', label: 'UnifiedSidebar', target: true, patterns: [/\bUnifiedSidebar\b/g] },
];

// CSS 质量指标
const CSS_METRICS = [
  { id: 'important', label: 'CSS !important', patterns: [/!important/g] },
  {
    id: 'hardcodedColor',
    label: '硬编码颜色值',
    patterns: [
      /(?:^|[:\s\[(,])#[0-9a-fA-F]{3,8}\b/g,
      /(?:^|[:\s\[(,])rgb[a]?\([^)]+\)/g,
      /(?:^|[:\s\[(,])hsl[a]?\(\s*(?!var\()[^)]+\)/g,
      /(?:^|[:\s\[(,])oklch\(\s*(?!var\()[^)]+\)/g,
      /(?:^|[:\s\[(,])oklab\(\s*(?!var\()[^)]+\)/g,
    ],
  },
  { id: 'inlineStyle', label: 'inline style=', patterns: [/style\s*=\s*\{/g] },
];

// ─── 文件遍历 ───────────────────────────────────────────────────

async function walkDir(dir) {
  const files = [];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    const relPath = relative(ROOT, fullPath);

    if (EXCLUDE_DIRS.has(entry.name) || EXCLUDE_DIRS.has(relPath)) continue;
    if (entry.name.startsWith('.')) continue;

    if (entry.isDirectory()) {
      files.push(...await walkDir(fullPath));
    } else if (SCAN_EXTS.has(extname(entry.name))) {
      // 排除测试文件
      if (entry.name.includes('.test.') || entry.name.includes('.spec.')) continue;
      files.push(fullPath);
    }
  }
  return files;
}

// ─── 主扫描逻辑 ─────────────────────────────────────────────────

async function main() {
  console.log('🔍 扫描 src/ 组件使用情况...');
  const startTime = Date.now();

  const allFiles = await walkDir(SRC);
  const tsxFiles = allFiles.filter(f => f.endsWith('.tsx'));

  console.log(`  文件总数: ${allFiles.length}, TSX 文件: ${tsxFiles.length}`);

  // 初始化结果
  const componentResults = {};
  for (const target of COMPONENT_TARGETS) {
    componentResults[target.id] = {
      id: target.id,
      label: target.label,
      target: target.target,
      refs: 0,
      files: 0,
      fileList: [],
    };
  }

  const cssResults = {};
  for (const metric of CSS_METRICS) {
    cssResults[metric.id] = {
      id: metric.id,
      label: metric.label,
      count: 0,
      files: 0,
      fileList: [],
    };
  }

  // 逐文件扫描
  for (const filePath of allFiles) {
    const content = await readFile(filePath, 'utf-8');
    const relPath = relative(ROOT, filePath);

    // 组件使用扫描
    for (const target of COMPONENT_TARGETS) {
      let matchCount = 0;
      for (const pattern of target.patterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        const matches = content.match(regex);
        if (matches) matchCount += matches.length;
      }
      if (matchCount > 0) {
        componentResults[target.id].refs += matchCount;
        componentResults[target.id].files += 1;
        componentResults[target.id].fileList.push(relPath);
      }
    }

    // CSS 质量指标扫描
    for (const metric of CSS_METRICS) {
      if (metric.id === 'hardcodedColor' && SEMANTIC_COLOR_SOURCE_FILES.has(relPath)) {
        continue;
      }

      let matchCount = 0;
      for (const pattern of metric.patterns) {
        const regex = new RegExp(pattern.source, pattern.flags);
        const matches = content.match(regex);
        if (matches) matchCount += matches.length;
      }
      if (matchCount > 0) {
        cssResults[metric.id].count += matchCount;
        cssResults[metric.id].files += 1;
        cssResults[metric.id].fileList.push(relPath);
      }
    }
  }

  // 计算迁移进度（按组件族）
  const migrationFamilies = [
    {
      id: 'button',
      label: 'Button',
      targetIds: ['NotionButton'],
      legacyIds: ['ShadButton', 'NativeButton'],
    },
    {
      id: 'formControls',
      label: 'Form Controls',
      targetIds: ['ShadInput', 'ShadTextarea', 'ShadSwitch', 'ShadCheckbox'],
      legacyIds: ['NativeInput', 'NativeSelect', 'NativeTextarea'],
    },
    {
      id: 'dialog',
      label: 'Dialog / Overlay',
      targetIds: ['NotionDialog'],
      legacyIds: ['ShadDialog', 'ShadSheet'],
    },
    {
      id: 'tooltip',
      label: 'Tooltip',
      targetIds: ['CommonTooltip'],
      legacyIds: ['ShadTooltip'],
    },
    {
      id: 'scroll',
      label: 'Scroll',
      targetIds: ['CustomScrollArea'],
      legacyIds: [],
    },
    {
      id: 'icons',
      label: 'Icons',
      targetIds: ['PhosphorIcons'],
      legacyIds: ['LucideIcons'],
    },
  ];

  const migrationProgress = migrationFamilies.map(family => {
    const targetRefs = family.targetIds.reduce((sum, id) => sum + (componentResults[id]?.refs || 0), 0);
    const legacyRefs = family.legacyIds.reduce((sum, id) => sum + (componentResults[id]?.refs || 0), 0);
    const total = targetRefs + legacyRefs;
    const percentage = total > 0 ? Math.round((targetRefs / total) * 100) : 100;

    return {
      id: family.id,
      label: family.label,
      targetRefs,
      legacyRefs,
      total,
      percentage,
      targetIds: family.targetIds,
      legacyIds: family.legacyIds,
    };
  });

  // 输出
  const output = {
    generatedAt: new Date().toISOString(),
    scanDurationMs: Date.now() - startTime,
    summary: {
      totalFiles: allFiles.length,
      tsxFiles: tsxFiles.length,
      cssFiles: allFiles.filter(f => f.endsWith('.css')).length,
    },
    components: componentResults,
    cssMetrics: cssResults,
    migrationProgress,
  };

  // 移除 fileList 中超过 20 条的截断（保留前 20 条 + 总数）
  for (const comp of Object.values(output.components)) {
    if (comp.fileList.length > 20) {
      comp.topFiles = comp.fileList.slice(0, 20);
      comp.totalFileCount = comp.fileList.length;
      delete comp.fileList;
    } else {
      comp.topFiles = comp.fileList;
      comp.totalFileCount = comp.fileList.length;
      delete comp.fileList;
    }
  }
  for (const metric of Object.values(output.cssMetrics)) {
    if (metric.fileList.length > 20) {
      metric.topFiles = metric.fileList.slice(0, 20);
      metric.totalFileCount = metric.fileList.length;
      delete metric.fileList;
    } else {
      metric.topFiles = metric.fileList;
      metric.totalFileCount = metric.fileList.length;
      delete metric.fileList;
    }
  }

  await writeFile(OUTPUT, JSON.stringify(output, null, 2), 'utf-8');
  console.log(`✅ 扫描完成 (${Date.now() - startTime}ms)`);
  console.log(`   输出: ${relative(ROOT, OUTPUT)}`);
  console.log(`   迁移进度:`);
  for (const p of migrationProgress) {
    const bar = '█'.repeat(Math.round(p.percentage / 5)) + '░'.repeat(20 - Math.round(p.percentage / 5));
    console.log(`     ${p.label.padEnd(16)} ${bar} ${p.percentage}% (${p.targetRefs}/${p.total})`);
  }
}

main().catch(err => {
  console.error('扫描失败:', err);
  process.exit(1);
});
