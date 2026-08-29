#!/usr/bin/env node
/**
 * 国际化检查工具
 * 用于检测项目中的国际化问题
 *
 * 退出语义（供 CI / npm script 消费）：
 *   - 默认模式：跨语言缺键、叶子非字符串、locale JSON 解析失败、
 *     对应语言 locale 文件缺失 → exit 1；否则 exit 0
 *   - --strict：在默认失败条件之外，t() 引用键在任一语言缺失、
 *     声明命名空间缺少 locale 文件 → 同样 exit 1
 *
 * 用法：
 *   node scripts/check-i18n.mjs            # npm run check:i18n
 *   node scripts/check-i18n.mjs --strict   # npm run check:i18n:strict
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.join(__dirname, '..');

const cliArgs = process.argv.slice(2);
const STRICT = cliArgs.includes('--strict');

/**
 * 全局问题计数，main() 末尾据此计算退出码
 * - 默认失败项：missingKeys / nonStringLeaves / parseErrors / missingLocaleFiles
 * - strict 追加失败项：missingUsedKeys / missingNamespaceFiles
 */
const summary = {
  missingKeys: 0,
  nonStringLeaves: 0,
  parseErrors: 0,
  missingLocaleFiles: 0,
  missingUsedKeys: 0,
  missingNamespaceFiles: 0,
};

// 颜色输出
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(color, ...args) {
  console.log(colors[color], ...args, colors.reset);
}

/**
 * 检查翻译文件完整性
 */
function checkTranslationFiles() {
  log('cyan', '\n=== 1. 翻译文件完整性检查 ===\n');
  
  const zhCNDir = path.join(projectRoot, 'src/locales/zh-CN');
  const enUSDir = path.join(projectRoot, 'src/locales/en-US');
  
  const zhFiles = fs.readdirSync(zhCNDir).filter(f => f.endsWith('.json'));
  const enFiles = fs.readdirSync(enUSDir).filter(f => f.endsWith('.json'));
  
  const missingInEn = zhFiles.filter(f => !enFiles.includes(f));
  const missingInZh = enFiles.filter(f => !zhFiles.includes(f));
  
  if (missingInEn.length > 0) {
    log('red', '❌ en-US 中缺失的文件:');
    missingInEn.forEach(f => console.log(`   - ${f}`));
    summary.missingLocaleFiles += missingInEn.length;
  }
  
  if (missingInZh.length > 0) {
    log('red', '❌ zh-CN 中缺失的文件:');
    missingInZh.forEach(f => console.log(`   - ${f}`));
    summary.missingLocaleFiles += missingInZh.length;
  }
  
  if (missingInEn.length === 0 && missingInZh.length === 0) {
    log('green', '✅ 翻译文件数量一致');
  }
  
  // 检查行数差异
  log('blue', '\n文件行数对比:');
  console.log('文件名'.padEnd(30), 'zh-CN'.padEnd(10), 'en-US'.padEnd(10), '差异');
  console.log('-'.repeat(65));
  
  const commonFiles = zhFiles.filter(f => enFiles.includes(f));
  let totalIssues = 0;
  
  commonFiles.forEach(file => {
    const zhPath = path.join(zhCNDir, file);
    const enPath = path.join(enUSDir, file);
    
    const zhLines = fs.readFileSync(zhPath, 'utf-8').split('\n').length;
    const enLines = fs.readFileSync(enPath, 'utf-8').split('\n').length;
    const diff = enLines - zhLines;
    
    const diffStr = diff > 0 ? `+${diff}` : diff.toString();
    const symbol = Math.abs(diff) > 10 ? '⚠️ ' : '  ';
    
    console.log(
      symbol + file.padEnd(28),
      zhLines.toString().padEnd(10),
      enLines.toString().padEnd(10),
      diffStr
    );
    
    if (Math.abs(diff) > 10) totalIssues++;
  });
  
  if (totalIssues > 0) {
    log('yellow', `\n⚠️  发现 ${totalIssues} 个文件存在较大差异 (>10行)`);
  }
}

/**
 * 递归获取所有键
 */
function getAllKeys(obj, prefix = '') {
  let keys = [];
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null && !Array.isArray(obj[key])) {
      keys = keys.concat(getAllKeys(obj[key], fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

/**
 * 收集叶子非字符串的键
 * 合法叶子：字符串；数组视为合法结构化叶子（returnObjects: true 下
 * review.weekdaysShort / template 示例等按数组消费）
 * 非法叶子：number / boolean / null
 * @returns {{ key: string, type: string }[]}
 */
function collectNonStringLeaves(obj, prefix = '') {
  const bad = [];
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    const value = obj[key];
    if (Array.isArray(value)) continue;
    if (value !== null && typeof value === 'object') {
      bad.push(...collectNonStringLeaves(value, fullKey));
    } else if (typeof value !== 'string') {
      bad.push({ key: fullKey, type: value === null ? 'null' : typeof value });
    }
  }
  return bad;
}

/**
 * 检查翻译键完整性
 */
function checkTranslationKeys() {
  log('cyan', '\n=== 2. 翻译键完整性检查 ===\n');
  
  const zhCNDir = path.join(projectRoot, 'src/locales/zh-CN');
  const enUSDir = path.join(projectRoot, 'src/locales/en-US');
  
  const files = fs.readdirSync(zhCNDir).filter(f => f.endsWith('.json'));
  
  let totalMissingInEn = 0;
  let totalMissingInZh = 0;
  let totalNonStringLeaves = 0;
  
  files.forEach(file => {
    const zhPath = path.join(zhCNDir, file);
    const enPath = path.join(enUSDir, file);
    
    if (!fs.existsSync(enPath)) {
      // 缺失文件已在第 1 节计入 summary.missingLocaleFiles
      log('yellow', `⏭️  跳过 ${file} (en-US文件不存在)`);
      return;
    }
    
    try {
      const zhContent = JSON.parse(fs.readFileSync(zhPath, 'utf-8'));
      const enContent = JSON.parse(fs.readFileSync(enPath, 'utf-8'));
      
      const zhKeys = getAllKeys(zhContent);
      const enKeys = getAllKeys(enContent);
      
      const missingInEn = zhKeys.filter(k => !enKeys.includes(k));
      const missingInZh = enKeys.filter(k => !zhKeys.includes(k));
      
      if (missingInEn.length > 0 || missingInZh.length > 0) {
        console.log(`\n📄 ${file}`);
        console.log(`   zh-CN: ${zhKeys.length} 个键`);
        console.log(`   en-US: ${enKeys.length} 个键`);
        
        if (missingInEn.length > 0) {
          log('red', `   ❌ en-US 缺失 ${missingInEn.length} 个键`);
          if (missingInEn.length <= 10) {
            missingInEn.forEach(k => console.log(`      - ${k}`));
          } else {
            missingInEn.slice(0, 5).forEach(k => console.log(`      - ${k}`));
            console.log(`      ... 还有 ${missingInEn.length - 5} 个键`);
          }
          totalMissingInEn += missingInEn.length;
        }
        
        if (missingInZh.length > 0) {
          log('red', `   ❌ zh-CN 缺失 ${missingInZh.length} 个键`);
          if (missingInZh.length <= 10) {
            missingInZh.forEach(k => console.log(`      - ${k}`));
          } else {
            missingInZh.slice(0, 5).forEach(k => console.log(`      - ${k}`));
            console.log(`      ... 还有 ${missingInZh.length - 5} 个键`);
          }
          totalMissingInZh += missingInZh.length;
        }
      } else {
        log('green', `✅ ${file}: 键完全一致 (${zhKeys.length} 个)`);
      }

      // 叶子类型检查：翻译值必须是字符串（数组作为结构化叶子放行）
      const badLeaves = [
        ...collectNonStringLeaves(zhContent).map((b) => ({ ...b, lang: 'zh-CN' })),
        ...collectNonStringLeaves(enContent).map((b) => ({ ...b, lang: 'en-US' })),
      ];
      if (badLeaves.length > 0) {
        log('red', `   ❌ ${file}: ${badLeaves.length} 个叶子非字符串`);
        badLeaves.slice(0, 10).forEach((b) => {
          console.log(`      - [${b.lang}] ${b.key} (${b.type})`);
        });
        if (badLeaves.length > 10) {
          console.log(`      ... 还有 ${badLeaves.length - 10} 处`);
        }
        totalNonStringLeaves += badLeaves.length;
      }
    } catch (error) {
      log('red', `❌ 解析 ${file} 时出错: ${error.message}`);
      summary.parseErrors += 1;
    }
  });
  
  if (totalMissingInEn > 0 || totalMissingInZh > 0 || totalNonStringLeaves > 0) {
    console.log('\n总计:');
    if (totalMissingInEn > 0) {
      log('red', `  en-US 总共缺失: ${totalMissingInEn} 个键`);
    }
    if (totalMissingInZh > 0) {
      log('red', `  zh-CN 总共缺失: ${totalMissingInZh} 个键`);
    }
    if (totalNonStringLeaves > 0) {
      log('red', `  叶子非字符串: ${totalNonStringLeaves} 处`);
    }
  }

  summary.missingKeys += totalMissingInEn + totalMissingInZh;
  summary.nonStringLeaves += totalNonStringLeaves;
}

/**
 * 将相对路径转为统一的 posix 风格，便于 glob 式排除匹配
 */
function toPosixRel(relPath) {
  return relPath.split(path.sep).join('/');
}

/**
 * 简单 glob 匹配（仅支持 **、* 与字面路径段）
 * 前缀 ** / 可匹配空路径，使 ** /anki/foo 也能匹配 anki/foo
 */
function matchGlob(relPosix, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '<<GS_SLASH>>')
    .replace(/\/\*\*/g, '<<SLASH_GS>>')
    .replace(/\*\*/g, '<<GS>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<GS_SLASH>>/g, '(?:.*/)?')
    .replace(/<<SLASH_GS>>/g, '(?:/.*)?')
    .replace(/<<GS>>/g, '.*');
  return new RegExp(`^${escaped}$`).test(relPosix);
}

function shouldExcludePath(relPosix, excludePatterns) {
  return excludePatterns.some((pattern) => {
    // 目录前缀式排除（如 style-lab/、**/dev/）
    if (pattern.endsWith('/') || pattern.endsWith('/**')) {
      const dir = pattern
        .replace(/^\*\*\//, '')
        .replace(/\/\*\*$/, '')
        .replace(/\/$/, '');
      if (relPosix === dir || relPosix.startsWith(`${dir}/`) || relPosix.includes(`/${dir}/`)) {
        return true;
      }
    }
    return matchGlob(relPosix, pattern)
      || matchGlob(path.basename(relPosix), pattern.replace(/^\*\*\//, ''));
  });
}

/**
 * 判断一行是否主要为调试/日志调用（此类中文不计入硬编码 UI）
 * 覆盖: console.log/warn/error/debug/info、debugLog、emitDebug、emit*Debug
 */
function isPrimarilyDebugOrConsoleLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return false;
  return /^(?:void\s+|await\s+)?(?:console\.(?:log|warn|error|debug|info)|debugLog|emit\w*Debug)\s*[\.(]/.test(
    trimmed,
  );
}

function extractChineseSamples(content) {
  // 排除注释和 import 语句中的中文
  const codeOnly = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '')
    .replace(/import\s+.*from\s+.*/g, '');

  // 再按行排除 console / debugLog / emit*Debug
  const withoutDebug = codeOnly
    .split('\n')
    .filter((line) => !isPrimarilyDebugOrConsoleLine(line))
    .join('\n');

  return withoutDebug.match(/[\u4e00-\u9fa5]{2,}/g);
}

/**
 * 扫描目录中的硬编码中文
 * @returns {{ file: string, count: number, samples: string[] }[]}
 */
function scanHardcodedChinese(rootDir, options = {}) {
  const {
    extensions = ['.tsx', '.ts'],
    excludePatterns = [],
    relativeTo = rootDir,
  } = options;
  const results = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      const filePath = path.join(dir, file);
      const relPosix = toPosixRel(path.relative(relativeTo, filePath));
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        if (shouldExcludePath(`${relPosix}/`, excludePatterns) || shouldExcludePath(relPosix, excludePatterns)) {
          continue;
        }
        walk(filePath);
        continue;
      }

      if (!extensions.some((ext) => file.endsWith(ext))) continue;
      if (shouldExcludePath(relPosix, excludePatterns)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const matches = extractChineseSamples(content);
      if (matches && matches.length > 0) {
        results.push({
          file: relPosix,
          count: matches.length,
          samples: [...new Set(matches)].slice(0, 3),
        });
      }
    }
  }

  walk(rootDir);
  results.sort((a, b) => b.count - a.count);
  return results;
}

/**
 * 扫描半本地化：defaultValue / t() 中带中文的 fallback
 * @returns {{ file: string, count: number, samples: string[] }[]}
 */
function scanSemiLocalization(rootDir, options = {}) {
  const {
    extensions = ['.tsx', '.ts'],
    excludePatterns = [],
    relativeTo = rootDir,
  } = options;

  // 约定模式：defaultValue: '…中文…' / t(…'…中文…')
  // 字面量内用 [^'"]* 代替贪婪 .*，避免同一行跨引号误吞导致漏计
  const defaultValueRe = /defaultValue:\s*['"][^'"]*[\u4e00-\u9fff]/g;
  const tFallbackRe = /t\([^)]*?['"][^'"]*[\u4e00-\u9fff]/g;

  const results = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      const filePath = path.join(dir, file);
      const relPosix = toPosixRel(path.relative(relativeTo, filePath));
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        if (shouldExcludePath(`${relPosix}/`, excludePatterns) || shouldExcludePath(relPosix, excludePatterns)) {
          continue;
        }
        walk(filePath);
        continue;
      }

      if (!extensions.some((ext) => file.endsWith(ext))) continue;
      if (shouldExcludePath(relPosix, excludePatterns)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      // 注释已剥离，避免 // defaultValue: '中文' 误报
      const codeOnly = content
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*/g, '');

      const dvMatches = codeOnly.match(defaultValueRe) || [];
      const tMatches = codeOnly.match(tFallbackRe) || [];
      const all = [...dvMatches, ...tMatches];
      if (all.length === 0) continue;

      const samples = [...new Set(all.map((m) => {
        const zh = m.match(/[\u4e00-\u9fff]+/g);
        return zh ? zh.join('') : m.slice(0, 24);
      }))].slice(0, 3);

      results.push({
        file: relPosix,
        count: all.length,
        samples,
      });
    }
  }

  walk(rootDir);
  results.sort((a, b) => b.count - a.count);
  return results;
}

/** 硬编码扫描共用的额外路径排除 */
const HARDCODE_PATH_EXCLUDES = [
  '**/skills/builtin/**',
  '**/skills/builtin-tools/**',
  '**/anki/cardforge/engines/**',
  '**/anki/cardforge/prompts/**',
  '**/mcp/builtinMcpServer.ts',
  'mcp/builtinMcpServer.ts',
];

/**
 * 检查硬编码中文
 */
function checkHardcodedChinese() {
  log('cyan', '\n=== 3. 硬编码中文检查 ===\n');

  const componentsDir = path.join(projectRoot, 'src/components');
  const featuresDir = path.join(projectRoot, 'src/features');
  const srcDir = path.join(projectRoot, 'src');

  const componentExclude = [
    'style-lab/',
    '**/dev/',
    '**/*Demo*',
    '**/*.example.*',
    '**/__tests__/',
    '**/*.test.*',
    '**/prompts/',
    ...HARDCODE_PATH_EXCLUDES,
  ];

  const featureExclude = [
    '**/__tests__/',
    '**/*.test.*',
    '**/dev/',
    '**/debug/**',
    '**/debug-panel/**',
    ...HARDCODE_PATH_EXCLUDES,
  ];

  const componentResults = scanHardcodedChinese(componentsDir, {
    extensions: ['.tsx', '.ts'],
    excludePatterns: componentExclude,
    relativeTo: componentsDir,
  });

  const featureResults = scanHardcodedChinese(featuresDir, {
    extensions: ['.tsx'],
    excludePatterns: featureExclude,
    relativeTo: featuresDir,
  });

  // --- components（主报告，保持原有摘要结构）---
  log('yellow', `发现 ${componentResults.length} 个文件包含硬编码中文\n`);

  if (componentResults.length > 0) {
    console.log('Top 20 硬编码中文最多的文件:\n');
    console.log('文件'.padEnd(60), '数量'.padEnd(8), '样本');
    console.log('-'.repeat(100));

    componentResults.slice(0, 20).forEach((r) => {
      console.log(
        r.file.padEnd(60),
        r.count.toString().padEnd(8),
        r.samples.join(', ').substring(0, 30),
      );
    });

    const totalHardcoded = componentResults.reduce((sum, r) => sum + r.count, 0);
    log('red', `\n❌ 总计: ${totalHardcoded} 处硬编码中文`);
  } else {
    log('green', '✅ 未发现硬编码中文');
  }

  // --- features UI（次级报告，单独 Top 15）---
  log('cyan', '\n--- features UI hardcode (tsx) ---\n');
  if (featureResults.length > 0) {
    log('yellow', `发现 ${featureResults.length} 个 features 文件包含硬编码中文\n`);
    console.log('Top 15 features UI hardcode:\n');
    console.log('文件'.padEnd(60), '数量'.padEnd(8), '样本');
    console.log('-'.repeat(100));

    featureResults.slice(0, 15).forEach((r) => {
      console.log(
        r.file.padEnd(60),
        r.count.toString().padEnd(8),
        r.samples.join(', ').substring(0, 30),
      );
    });

    const featureTotal = featureResults.reduce((sum, r) => sum + r.count, 0);
    log('yellow', `\n⚠️  features UI 总计: ${featureTotal} 处硬编码中文`);
  } else {
    log('green', '✅ features UI 未发现硬编码中文');
  }

  // --- 半本地化：Chinese defaultValue / t fallback ---
  log('cyan', '\n--- 半本地化 (Chinese defaultValue / t fallback) ---\n');

  const semiExclude = [
    '**/__tests__/',
    '**/*.test.*',
    '**/dev/',
    '**/debug/**',
    'style-lab/',
    '**/style-lab/**',
    ...HARDCODE_PATH_EXCLUDES,
  ];

  const semiResults = scanSemiLocalization(srcDir, {
    extensions: ['.tsx', '.ts'],
    excludePatterns: semiExclude,
    relativeTo: srcDir,
  });

  if (semiResults.length > 0) {
    const semiTotal = semiResults.reduce((sum, r) => sum + r.count, 0);
    log('yellow', `发现 ${semiResults.length} 个文件含中文 defaultValue / t fallback（共 ${semiTotal} 处）\n`);
    console.log('Top 15 半本地化文件:\n');
    console.log('文件'.padEnd(60), '数量'.padEnd(8), '样本');
    console.log('-'.repeat(100));

    semiResults.slice(0, 15).forEach((r) => {
      console.log(
        r.file.padEnd(60),
        r.count.toString().padEnd(8),
        r.samples.join(', ').substring(0, 30),
      );
    });
  } else {
    log('green', '✅ 未发现中文 defaultValue / t fallback');
  }
}

/**
 * 检查i18n配置
 */
function checkI18nConfig() {
  log('cyan', '\n=== 4. i18n 配置检查 ===\n');
  
  const i18nPath = path.join(projectRoot, 'src/i18n.ts');
  
  if (!fs.existsSync(i18nPath)) {
    log('red', '❌ 未找到 i18n.ts 配置文件');
    return;
  }
  
  const content = fs.readFileSync(i18nPath, 'utf-8');

  // 检查命名空间声明：兼容 const ALL_NS + ns: ALL_NS 的写法
  const allNsMatch = content.match(/const\s+ALL_NS\s*=\s*\[(.*?)\]/s);
  const declaredNs = allNsMatch
    ? allNsMatch[1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, ''))
      .filter(s => s.length > 0)
    : [];

  if (declaredNs.length > 0) {
    log('blue', `声明的命名空间 (${declaredNs.length}个):`);
    console.log('  ', declaredNs.join(', '));

    const zhCNDir = path.join(projectRoot, 'src/locales/zh-CN');
    const enUSDir = path.join(projectRoot, 'src/locales/en-US');
    const zhFiles = new Set(fs.readdirSync(zhCNDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));
    const enFiles = new Set(fs.readdirSync(enUSDir).filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, '')));

    const missingZhNs = declaredNs.filter(ns => !zhFiles.has(ns));
    const missingEnNs = declaredNs.filter(ns => !enFiles.has(ns));

    if (missingZhNs.length === 0 && missingEnNs.length === 0) {
      log('green', '\n✅ 所有声明命名空间都存在对应 locale 文件');
    } else {
      if (missingZhNs.length > 0) {
        log('yellow', '\n⚠️  zh-CN 缺失命名空间文件:');
        missingZhNs.forEach(ns => console.log(`   - ${ns}.json`));
      }
      if (missingEnNs.length > 0) {
        log('yellow', '\n⚠️  en-US 缺失命名空间文件:');
        missingEnNs.forEach(ns => console.log(`   - ${ns}.json`));
      }
      // strict 模式下声明命名空间缺文件视为失败
      summary.missingNamespaceFiles += missingZhNs.length + missingEnNs.length;
    }
  } else {
    log('yellow', '⚠️  未解析到 ALL_NS 命名空间列表');
  }

  if (content.includes('ns: ALL_NS')) {
    log('green', '\n✅ i18n ns 已绑定 ALL_NS');
  } else {
    log('yellow', '\n⚠️  未检测到 ns: ALL_NS');
  }

  // 检查 fallback 配置：兼容对象或字符串写法
  const hasFallbackLng = /fallbackLng\s*:\s*({[\s\S]*?}|'[^']+'|"[^"]+")/.test(content);
  const hasDefaultFallbackEn = /fallbackLng\s*:\s*{[\s\S]*?default\s*:\s*\[\s*['"]en-US['"]\s*]/.test(content);
  if (hasFallbackLng) {
    if (hasDefaultFallbackEn) {
      log('green', '✅ fallbackLng 配置存在，且 default 包含 en-US');
    } else {
      log('yellow', '⚠️  fallbackLng 已配置，但未检测到 default: [\"en-US\"]');
    }
  } else {
    log('yellow', '⚠️  未找到 fallbackLng 配置');
  }

  if (/fallbackNS\s*:\s*FALLBACK_NS/.test(content)) {
    log('green', '✅ fallbackNS 已绑定 FALLBACK_NS');
  } else if (/fallbackNS\s*:/.test(content)) {
    log('green', '✅ fallbackNS 已配置');
  } else {
    log('yellow', '⚠️  未找到 fallbackNS 配置');
  }
}

// i18next 复数后缀：t('x', { count }) 实际引用 x_one / x_other 等
const PLURAL_SUFFIX_RE = /_(zero|one|two|few|many|other)$/;

function addNodePaths(obj, prefix, index) {
  for (const key in obj) {
    const fullKey = prefix ? `${prefix}.${key}` : key;
    index.add(fullKey);
    const pluralBase = fullKey.replace(PLURAL_SUFFIX_RE, '');
    if (pluralBase !== fullKey) index.add(pluralBase);
    const value = obj[key];
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      addNodePaths(value, fullKey, index);
    }
  }
}

/**
 * 构建某语言的键索引：全命名空间并集下的裸键路径集合。
 * defaultNS: 'common' + fallbackNS: 其余全部命名空间，意味着运行时
 * 键只要在任一命名空间存在即可解析，因此按并集判断不会产生误报。
 * 索引同时包含中间对象节点（returnObjects: true）与复数基名。
 */
function buildLangKeyIndex(localeDir) {
  const index = new Set();
  if (!fs.existsSync(localeDir)) return index;
  const files = fs.readdirSync(localeDir).filter(f => f.endsWith('.json'));
  for (const file of files) {
    let content;
    try {
      content = JSON.parse(fs.readFileSync(path.join(localeDir, file), 'utf-8'));
    } catch {
      continue; // 解析错误已在第 2 节计入 summary.parseErrors
    }
    addNodePaths(content, '', index);
  }
  return index;
}

// t('key') / i18n.t('key') / i18next.t('key')；排除 props.t( 等其他成员调用
const T_CALL_RE = /(?:^|[^\w$.])(?:i18n(?:ext)?\.)?t\(\s*(['"`])([^'"`\n]+?)\1/g;
const I18N_KEY_ATTR_RE = /i18nKey=["']([^"']+)["']/g;
// 合法静态键：可选 ns 前缀 + 点分路径；带空格/中文/插值的字符串视为非键
const KEY_CANDIDATE_RE = /^(?:[\w$-]+:)?[\w$-]+(?:\.[\w$-]+)*$/;

function extractUsedKeysFromSource(content) {
  const codeOnly = content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*/g, '');

  // keyPrefix 文件中裸键无法静态还原完整路径，仅保留显式 ns:key 引用
  const hasKeyPrefix = codeOnly.includes('keyPrefix');
  const keys = [];

  const pushCandidate = (candidate) => {
    if (!KEY_CANDIDATE_RE.test(candidate)) return;
    if (hasKeyPrefix && !candidate.includes(':')) return;
    keys.push(candidate);
  };

  for (const match of codeOnly.matchAll(T_CALL_RE)) {
    pushCandidate(match[2]);
  }
  for (const match of codeOnly.matchAll(I18N_KEY_ATTR_RE)) {
    pushCandidate(match[1]);
  }
  return keys;
}

/**
 * 检查 t() 引用键双语存在性
 * 默认模式仅报告；--strict 下缺失计入失败（exit 1）
 */
function checkUsedTranslationKeys() {
  log('cyan', '\n=== 5. t() 引用键双语检查 ===\n');

  const zhIndex = buildLangKeyIndex(path.join(projectRoot, 'src/locales/zh-CN'));
  const enIndex = buildLangKeyIndex(path.join(projectRoot, 'src/locales/en-US'));

  const srcDir = path.join(projectRoot, 'src');
  const excludePatterns = [
    '**/__tests__/',
    '**/*.test.*',
    '**/*.stories.*',
    '**/dev/',
    'style-lab/',
    '**/style-lab/**',
    'locales/',
  ];

  // bareKey -> Set<相对文件路径>
  const used = new Map();
  let scannedFiles = 0;

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      const filePath = path.join(dir, file);
      const relPosix = toPosixRel(path.relative(srcDir, filePath));
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        if (shouldExcludePath(`${relPosix}/`, excludePatterns) || shouldExcludePath(relPosix, excludePatterns)) {
          continue;
        }
        walk(filePath);
        continue;
      }

      if (!['.tsx', '.ts'].some((ext) => file.endsWith(ext))) continue;
      if (shouldExcludePath(relPosix, excludePatterns)) continue;

      const content = fs.readFileSync(filePath, 'utf-8');
      const candidates = extractUsedKeysFromSource(content);
      if (candidates.length === 0) continue;

      scannedFiles++;
      for (const candidate of candidates) {
        const colonIdx = candidate.indexOf(':');
        const bareKey = colonIdx >= 0 ? candidate.slice(colonIdx + 1) : candidate;
        if (!used.has(bareKey)) used.set(bareKey, new Set());
        used.get(bareKey).add(relPosix);
      }
    }
  }

  walk(srcDir);

  const missingInZh = [];
  const missingInEn = [];
  for (const [key, files] of used) {
    if (!zhIndex.has(key)) missingInZh.push({ key, file: [...files][0] });
    if (!enIndex.has(key)) missingInEn.push({ key, file: [...files][0] });
  }

  console.log(`扫描 ${scannedFiles} 个含 t() 引用的源文件，提取 ${used.size} 个静态键`);

  const reportMissing = (label, list) => {
    log('red', `\n❌ ${label} 缺失 ${list.length} 个被引用键:`);
    list.slice(0, 20).forEach(({ key, file }) => {
      console.log(`   - ${key}  (${file})`);
    });
    if (list.length > 20) {
      console.log(`   ... 还有 ${list.length - 20} 个键`);
    }
  };

  if (missingInZh.length === 0 && missingInEn.length === 0) {
    log('green', '✅ 全部 t() 引用键在 zh-CN / en-US 均存在');
  } else {
    if (missingInZh.length > 0) reportMissing('zh-CN', missingInZh);
    if (missingInEn.length > 0) reportMissing('en-US', missingInEn);
    summary.missingUsedKeys += missingInZh.length + missingInEn.length;
    if (!STRICT) {
      log('yellow', '\n⚠️  默认模式下引用键缺失仅告警；--strict 下将 exit 1');
    }
  }
}

/**
 * 计算退出码
 * 默认失败项：跨语言缺键 / 叶子非字符串 / JSON 解析失败 / locale 文件缺失
 * strict 追加失败项：t() 引用键缺失 / 声明命名空间缺文件
 */
function computeExitCode() {
  const hardErrors =
    summary.missingKeys
    + summary.nonStringLeaves
    + summary.parseErrors
    + summary.missingLocaleFiles;
  const strictErrors = summary.missingUsedKeys + summary.missingNamespaceFiles;

  if (hardErrors > 0) return 1;
  if (STRICT && strictErrors > 0) return 1;
  return 0;
}

/**
 * 生成摘要报告
 */
function generateSummary(exitCode) {
  log('cyan', '\n' + '='.repeat(70));
  log('cyan', '                    国际化检查摘要');
  log('cyan', '='.repeat(70) + '\n');

  console.log(`模式: ${STRICT ? 'strict (--strict)' : '默认'}`);
  console.log('问题计数:');
  console.log(`  跨语言缺键:        ${summary.missingKeys}`);
  console.log(`  叶子非字符串:      ${summary.nonStringLeaves}`);
  console.log(`  JSON 解析失败:     ${summary.parseErrors}`);
  console.log(`  locale 文件缺失:   ${summary.missingLocaleFiles}`);
  console.log(`  t() 引用键缺失:    ${summary.missingUsedKeys}${STRICT ? '' : ' (默认模式不计入失败)'}`);
  console.log(`  命名空间缺文件:    ${summary.missingNamespaceFiles}${STRICT ? '' : ' (默认模式不计入失败)'}`);

  if (exitCode === 0) {
    log('green', '\n✅ 检查通过 (exit 0)');
  } else {
    log('red', '\n❌ 检查未通过 (exit 1)');
  }

  console.log('\n详细的缺失键报告请运行: npm run check:i18n:missing（输出至 note/翻译键缺失详细报告.md）');
  console.log('建议操作:');
  console.log('  1. 创建缺失的翻译文件');
  console.log('  2. 补全翻译键');
  console.log('  3. 修复硬编码中文最多的组件\n');
}

// 主函数
function main() {
  console.log('\n');
  log('cyan', '╔════════════════════════════════════════════════════════════╗');
  log('cyan', '║          Deep Student - 国际化检查工具                     ║');
  log('cyan', '╚════════════════════════════════════════════════════════════╝');
  if (STRICT) {
    log('yellow', '（strict 模式：引用键缺失 / 命名空间缺文件也将 exit 1）');
  }
  
  try {
    checkTranslationFiles();
    checkTranslationKeys();
    checkHardcodedChinese();
    checkI18nConfig();
    checkUsedTranslationKeys();
  } catch (error) {
    log('red', '\n❌ 检查过程中发生错误:');
    console.error(error);
    process.exit(1);
  }

  const exitCode = computeExitCode();
  generateSummary(exitCode);
  process.exit(exitCode);
}

main();
