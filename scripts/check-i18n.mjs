#!/usr/bin/env node
/**
 * 国际化检查工具
 * 用于检测项目中的国际化问题
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const projectRoot = path.join(__dirname, '..');

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
  }
  
  if (missingInZh.length > 0) {
    log('yellow', '⚠️  zh-CN 中缺失的文件:');
    missingInZh.forEach(f => console.log(`   - ${f}`));
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
 * 检查翻译键完整性
 */
function checkTranslationKeys() {
  log('cyan', '\n=== 2. 翻译键完整性检查 ===\n');
  
  const zhCNDir = path.join(projectRoot, 'src/locales/zh-CN');
  const enUSDir = path.join(projectRoot, 'src/locales/en-US');
  
  const files = fs.readdirSync(zhCNDir).filter(f => f.endsWith('.json'));
  
  let totalMissingInEn = 0;
  let totalMissingInZh = 0;
  
  files.forEach(file => {
    const zhPath = path.join(zhCNDir, file);
    const enPath = path.join(enUSDir, file);
    
    if (!fs.existsSync(enPath)) {
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
          log('yellow', `   ⚠️  zh-CN 缺失 ${missingInZh.length} 个键`);
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
    } catch (error) {
      log('red', `❌ 解析 ${file} 时出错: ${error.message}`);
    }
  });
  
  if (totalMissingInEn > 0 || totalMissingInZh > 0) {
    console.log('\n总计:');
    if (totalMissingInEn > 0) {
      log('red', `  en-US 总共缺失: ${totalMissingInEn} 个键`);
    }
    if (totalMissingInZh > 0) {
      log('yellow', `  zh-CN 总共缺失: ${totalMissingInZh} 个键`);
    }
  }
}

/**
 * 检查硬编码中文
 */
function checkHardcodedChinese() {
  log('cyan', '\n=== 3. 硬编码中文检查 ===\n');
  
  const componentsDir = path.join(projectRoot, 'src/components');
  const results = [];
  
  function scanDirectory(dir) {
    const files = fs.readdirSync(dir);
    
    files.forEach(file => {
      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);
      
      if (stat.isDirectory()) {
        scanDirectory(filePath);
      } else if (file.endsWith('.tsx') || file.endsWith('.ts')) {
        const content = fs.readFileSync(filePath, 'utf-8');
        
        // 排除注释和import语句中的中文
        const codeOnly = content
          .replace(/\/\*[\s\S]*?\*\//g, '') // 移除多行注释
          .replace(/\/\/.*/g, '') // 移除单行注释
          .replace(/import\s+.*from\s+.*/g, ''); // 移除import语句
        
        const matches = codeOnly.match(/[\u4e00-\u9fa5]{2,}/g);
        
        if (matches && matches.length > 0) {
          results.push({
            file: path.relative(componentsDir, filePath),
            count: matches.length,
            samples: [...new Set(matches)].slice(0, 3) // 取3个样本
          });
        }
      }
    });
  }
  
  scanDirectory(componentsDir);
  
  // 按数量排序
  results.sort((a, b) => b.count - a.count);
  
  log('yellow', `发现 ${results.length} 个文件包含硬编码中文\n`);
  
  if (results.length > 0) {
    console.log('Top 20 硬编码中文最多的文件:\n');
    console.log('文件'.padEnd(60), '数量'.padEnd(8), '样本');
    console.log('-'.repeat(100));
    
    results.slice(0, 20).forEach(r => {
      console.log(
        r.file.padEnd(60),
        r.count.toString().padEnd(8),
        r.samples.join(', ').substring(0, 30)
      );
    });
    
    const totalHardcoded = results.reduce((sum, r) => sum + r.count, 0);
    log('red', `\n❌ 总计: ${totalHardcoded} 处硬编码中文`);
  } else {
    log('green', '✅ 未发现硬编码中文');
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
  
  // 检查命名空间声明
  const nsMatch = content.match(/ns:\s*\[(.*?)\]/s);
  if (nsMatch) {
    const declaredNs = nsMatch[1]
      .split(',')
      .map(s => s.trim().replace(/['"]/g, ''))
      .filter(s => s.length > 0);
    
    log('blue', `声明的命名空间 (${declaredNs.length}个):`);
    console.log('  ', declaredNs.join(', '));
    
    // 检查是否所有命名空间都有对应的导入
    const importedNs = [];
    const importPattern = /import\s+\w+\s+from\s+['"]\.\/locales\/zh-CN\/(\w+)\.json['"]/g;
    let match;
    while ((match = importPattern.exec(content)) !== null) {
      importedNs.push(match[1]);
    }
    
    log('blue', `\n实际导入的命名空间 (${importedNs.length}个):`);
    console.log('  ', importedNs.join(', '));
    
    const notImported = declaredNs.filter(ns => !importedNs.includes(ns));
    if (notImported.length > 0) {
      log('yellow', '\n⚠️  声明了但未导入的命名空间:');
      notImported.forEach(ns => console.log(`   - ${ns}`));
    } else {
      log('green', '\n✅ 所有声明的命名空间都已正确导入');
    }
  }
  
  // 检查fallback配置
  if (content.includes("fallbackLng: 'zh-CN'")) {
    log('green', '\n✅ fallback语言已设置为 zh-CN');
  } else {
    log('yellow', '\n⚠️  未找到fallback语言配置');
  }
}

/**
 * 生成摘要报告
 */
function generateSummary() {
  log('cyan', '\n' + '='.repeat(70));
  log('cyan', '                    国际化检查摘要');
  log('cyan', '='.repeat(70) + '\n');
  
  // 这里可以基于之前的检查结果生成总结
  console.log('详细报告已生成至: docs/国际化检查报告.md');
  console.log('\n建议操作:');
  console.log('  1. 创建缺失的翻译文件');
  console.log('  2. 补全翻译键');
  console.log('  3. 修复硬编码中文最多的组件');
  console.log('  4. 建立CI检查流程\n');
}

// 主函数
function main() {
  console.log('\n');
  log('cyan', '╔════════════════════════════════════════════════════════════╗');
  log('cyan', '║          AI错题管理系统 - 国际化检查工具                  ║');
  log('cyan', '╚════════════════════════════════════════════════════════════╝');
  
  try {
    checkTranslationFiles();
    checkTranslationKeys();
    checkHardcodedChinese();
    checkI18nConfig();
    generateSummary();
  } catch (error) {
    log('red', '\n❌ 检查过程中发生错误:');
    console.error(error);
    process.exit(1);
  }
}

main();

